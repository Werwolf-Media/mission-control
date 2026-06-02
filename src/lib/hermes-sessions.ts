/**
 * Hermes Agent Session Scanner — reads ~/.hermes/state.db (SQLite)
 * to discover hermes-agent sessions and map them to MC's unified session format.
 *
 * Opens the database read-only to avoid locking conflicts with a running agent.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { config } from './config'
import { logger } from './logger'

const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes — hermes sessions are shorter-lived
const DEFAULT_SESSION_LIMIT = 100

export interface HermesSessionStats {
  sessionId: string
  source: string           // 'cli', 'telegram', 'discord', etc.
  model: string | null
  title: string | null
  messageCount: number
  toolCallCount: number
  inputTokens: number
  outputTokens: number
  firstMessageAt: string | null
  lastMessageAt: string | null
  isActive: boolean
  // Werwolf-Media fork patch: profile/tenant identifier so multi-tenant
  // setups can route sessions to MC workspaces. Empty/'default' for the
  // root profile, otherwise the directory name under .hermes/profiles/.
  profile: string
}

interface HermesSessionRow {
  id: string
  source: string | null
  user_id: string | null
  model: string | null
  started_at: number | null
  ended_at: number | null
  message_count: number | null
  tool_call_count: number | null
  input_tokens: number | null
  output_tokens: number | null
  title: string | null
}

/**
 * Candidate paths where Hermes state files may live.
 * Werwolf-Media fork patch: in Docker, HOME=/nonexistent so the upstream
 * `homeDir`-only path never matches. We also check dataDir (where the
 * sidecar volume is typically mounted to `/app/.data/.hermes`).
 */
function getHermesDataRoots(): string[] {
  const path = require('node:path')
  const dataDir = path.resolve(config.dataDir || '.data')
  const homeDir = config.homeDir || process.env.HOME || ''
  const roots = new Set<string>()
  if (homeDir && homeDir !== '/nonexistent') roots.add(join(homeDir, '.hermes'))
  roots.add(join(dataDir, '.hermes'))
  if (process.env.HERMES_HOME) roots.add(process.env.HERMES_HOME)
  return [...roots]
}

function getHermesDbPath(): string {
  // Returns the first existing candidate, or the upstream-default for parity.
  for (const root of getHermesDataRoots()) {
    const p = join(root, 'state.db')
    if (existsSync(p)) return p
  }
  return join(config.homeDir, '.hermes', 'state.db')
}

function getHermesPidPath(): string {
  for (const root of getHermesDataRoots()) {
    const p = join(root, 'gateway.pid')
    if (existsSync(p)) return p
  }
  return join(config.homeDir, '.hermes', 'gateway.pid')
}

let hermesBinaryCache: { checkedAt: number; installed: boolean } | null = null

function hasHermesCliBinary(): boolean {
  const now = Date.now()
  if (hermesBinaryCache && now - hermesBinaryCache.checkedAt < 30_000) {
    return hermesBinaryCache.installed
  }

  // Check common install locations including the data directory's local bin.
  // In Docker, HOME=/nonexistent so we also check dataDir as effective HOME.
  const dataDir = require('node:path').resolve(config.dataDir || '.data')
  const homeDir = config.homeDir || process.env.HOME || ''
  const candidates = [
    process.env.HERMES_BIN,
    join(dataDir, '.local', 'bin', 'hermes'),
    join(dataDir, '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'),
    join(homeDir, '.local', 'bin', 'hermes'),
    join(homeDir, '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'),
    'hermes-agent',
    'hermes',
  ].filter((v): v is string => Boolean(v && v.trim()))
  const installed = candidates.some((bin) => {
    try {
      // First check if the file exists (fast path for absolute paths)
      if (bin.startsWith('/') && !existsSync(bin)) {
        logger.debug({ bin }, 'hermes candidate not found on disk')
        return false
      }
      // hermes CLI doesn't support --version (exits 2). Use --help as probe.
      const res = spawnSync(bin, ['--help'], { stdio: 'pipe', timeout: 5000 })
      const found = res.status === 0
      if (found) {
        logger.info({ bin, stdout: (res.stdout || '').toString().trim().slice(0, 60) }, 'hermes binary detected')
      }
      return found
    } catch (err) {
      logger.debug({ bin, err }, 'hermes candidate check failed')
      return false
    }
  })

  hermesBinaryCache = { checkedAt: now, installed }
  return installed
}

export function clearHermesDetectionCache(): void {
  hermesBinaryCache = null
}

/**
 * Check if Hermes is "installed" from MC's perspective.
 *
 * Returns true when either:
 *   1. The Hermes CLI binary exists on disk and responds to `--help` (classic local install)
 *   2. A `state.db` exists at the expected path (Docker sidecar pattern, e.g. Hostinger
 *      VPS-AI setup where `nousresearch/hermes-agent` runs in its own container and
 *      shares /opt/data with MC via a named volume mounted at /app/.data/.hermes:ro).
 *
 * Upstream MC only checks (1), which breaks the documented sidecar pattern when MC
 * itself doesn't have a Hermes binary installed. (Werwolf-Media fork patch)
 */
export function isHermesInstalled(): boolean {
  return hasHermesCliBinary() || hasHermesStateDb()
}

function hasHermesStateDb(): boolean {
  // Check all candidate roots AND profile subdirs.
  // Werwolf-Media fork patch — supports Hermes multi-profile layout
  // (one state.db per profile under .hermes/profiles/<name>/).
  return getAllHermesStateDbPaths().length > 0
}

/**
 * Return every state.db file we can find — the root profile and every
 * Hermes sub-profile under .hermes/profiles/*. Used for multi-tenant
 * deployments where each MC workspace maps to a Hermes profile.
 * Werwolf-Media fork patch.
 */
function getAllHermesStateDbPaths(): Array<{ path: string; profile: string }> {
  const { readdirSync, statSync } = require('node:fs')
  const results: Array<{ path: string; profile: string }> = []
  const seen = new Set<string>()

  for (const root of getHermesDataRoots()) {
    // Root profile
    const rootDb = join(root, 'state.db')
    if (!seen.has(rootDb)) {
      try { if (existsSync(rootDb)) { results.push({ path: rootDb, profile: 'default' }); seen.add(rootDb) } }
      catch { /* ignore */ }
    }

    // Profiles directory
    const profilesDir = join(root, 'profiles')
    try {
      if (!existsSync(profilesDir)) continue
      for (const name of readdirSync(profilesDir)) {
        try {
          const profileDir = join(profilesDir, name)
          if (!statSync(profileDir).isDirectory()) continue
          const dbPath = join(profileDir, 'state.db')
          if (seen.has(dbPath)) continue
          if (existsSync(dbPath)) {
            results.push({ path: dbPath, profile: name })
            seen.add(dbPath)
          }
        } catch { /* skip unreadable entries */ }
      }
    } catch { /* profiles dir missing — fine */ }
  }
  return results
}

function parseGatewayPid(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null

  // Legacy/simple format: file contains only PID text
  if (/^\d+$/.test(text)) {
    const pid = Number.parseInt(text, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  }

  // Current Hermes format: JSON object with pid field
  try {
    const parsed = JSON.parse(text) as { pid?: number | string } | null
    const value = parsed?.pid
    const pid = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function isHermesGatewayRunning(): boolean {
  // Werwolf-Media fork patch: check root profile + every Hermes sub-profile.
  // Returns true if ANY gateway has both pidfile + lockfile (or process is live).
  const path = require('node:path')
  const candidates: string[] = []

  for (const root of getHermesDataRoots()) {
    candidates.push(join(root, 'gateway.pid'))
    const profilesDir = join(root, 'profiles')
    try {
      if (!existsSync(profilesDir)) continue
      const { readdirSync, statSync } = require('node:fs')
      for (const name of readdirSync(profilesDir)) {
        try {
          const p = join(profilesDir, name)
          if (statSync(p).isDirectory()) candidates.push(join(p, 'gateway.pid'))
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return candidates.some((pidPath) => {
    if (!existsSync(pidPath)) return false
    try {
      const pidStr = readFileSync(pidPath, 'utf8')
      const pid = parseGatewayPid(pidStr)
      if (!pid) return false
      try {
        process.kill(pid, 0)
        return true
      } catch {
        const lockPath = join(path.dirname(pidPath), 'gateway.lock')
        return existsSync(lockPath)
      }
    } catch { return false }
  })
}

function epochSecondsToISO(epoch: number | null): string | null {
  if (!epoch || !Number.isFinite(epoch) || epoch <= 0) return null
  // Hermes stores timestamps as epoch seconds
  return new Date(epoch * 1000).toISOString()
}

export function scanHermesSessions(limit = DEFAULT_SESSION_LIMIT): HermesSessionStats[] {
  // Werwolf-Media fork patch: iterate over every state.db we can find
  // (root + each profile under .hermes/profiles/) and merge sessions.
  // Each session is tagged with its source profile so MC can route it
  // to the matching workspace.
  const dbPaths = getAllHermesStateDbPaths()
  if (dbPaths.length === 0) return []

  const now = Date.now()
  const gatewayRunning = isHermesGatewayRunning()
  const all: HermesSessionStats[] = []

  for (const { path: dbPath, profile } of dbPaths) {
    let db: Database.Database | null = null
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true })

      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
      ).get() as { name?: string } | undefined
      if (!tableCheck?.name) continue

      const rows = db.prepare(`
        SELECT id, source, user_id, model, started_at, ended_at,
               message_count, tool_call_count, input_tokens, output_tokens, title
        FROM sessions
        ORDER BY COALESCE(ended_at, started_at) DESC
        LIMIT ?
      `).all(limit) as HermesSessionRow[]

      for (const row of rows) {
        const firstMessageAt = epochSecondsToISO(row.started_at)
        let lastMessageAt = epochSecondsToISO(row.ended_at)

        if (!lastMessageAt && row.started_at) {
          try {
            const latestMsg = db!.prepare(
              'SELECT MAX(timestamp) as ts FROM messages WHERE session_id = ?'
            ).get(row.id) as { ts: number | null } | undefined
            if (latestMsg?.ts) lastMessageAt = epochSecondsToISO(latestMsg.ts)
          } catch { /* messages table may not exist */ }
        }

        if (!lastMessageAt) lastMessageAt = firstMessageAt

        const lastMs = lastMessageAt ? new Date(lastMessageAt).getTime() : 0
        const isActive = row.ended_at === null
          && lastMs > 0
          && (now - lastMs) < ACTIVE_THRESHOLD_MS
          && gatewayRunning

        all.push({
          sessionId: row.id,
          source: row.source || 'cli',
          model: row.model || null,
          title: row.title || null,
          messageCount: row.message_count || 0,
          toolCallCount: row.tool_call_count || 0,
          inputTokens: row.input_tokens || 0,
          outputTokens: row.output_tokens || 0,
          firstMessageAt,
          lastMessageAt,
          isActive,
          profile,
        })
      }
    } catch (err) {
      logger.warn({ err, dbPath, profile }, 'Failed to scan Hermes profile')
    } finally {
      try { db?.close() } catch { /* ignore */ }
    }
  }

  // Sort newest-first across all profiles, then trim to limit.
  all.sort((a, b) => {
    const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
    const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
    return tb - ta
  })
  return all.slice(0, limit)
}
