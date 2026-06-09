/**
 * Agent Provisioner — Werwolf-Media fork Patch 9.2
 *
 * Creates Hermes profile + sets provider key + restarts gateway + registers
 * agent in MC DB. Mirrors the /usr/local/bin/mc-new-agent VPS shell script
 * but invokable from the MC backend so the UI can wrap it in a wizard.
 *
 * Requires:
 *   - Docker CLI in the image (Dockerfile patch 9.1)
 *   - /var/run/docker.sock mounted from host (docker-compose)
 *   - hermes-agent container name reachable via docker
 */

import { runCommand } from './command'
import { getDatabase, logAuditEvent } from './db'
import { logger } from './logger'

const ROLE_SUFFIXES = ['coder', 'reviewer', 'tester', 'devops', 'researcher', 'assistant', 'agent']
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/

export interface ProvisionHermesAgentRequest {
  workspaceSlug: string
  role: string
  providerKey: string
  /** override container name (default: hermes-agent) */
  hermesContainer?: string
  /** which env var to set the key as (default: OPENROUTER_API_KEY) */
  providerKeyEnvVar?: string
  /** actor for audit log */
  actor: string
}

export interface ProvisionResult {
  ok: boolean
  agentId?: number
  agentName?: string
  message: string
  steps: Array<{ step: string; ok: boolean; detail?: string }>
}

const PROVISIONABLE_ROLES = new Set(ROLE_SUFFIXES)

export async function provisionHermesAgent(
  req: ProvisionHermesAgentRequest
): Promise<ProvisionResult> {
  const steps: ProvisionResult['steps'] = []
  const log = (step: string, ok: boolean, detail?: string) => {
    steps.push({ step, ok, detail })
    logger.info({ step, ok, detail }, '[provisioner]')
  }

  // ── Validate ────────────────────────────────────────────────────────────
  if (!NAME_RE.test(req.workspaceSlug)) {
    return { ok: false, message: `Invalid workspace slug: ${req.workspaceSlug}`, steps }
  }
  if (!PROVISIONABLE_ROLES.has(req.role)) {
    return { ok: false, message: `Invalid role. Use one of: ${[...PROVISIONABLE_ROLES].join(', ')}`, steps }
  }
  if (!req.providerKey || !req.providerKey.trim().startsWith('sk-')) {
    return { ok: false, message: 'Provider key must look like an API key (sk-…)', steps }
  }

  const keyEnv = req.providerKeyEnvVar || 'OPENROUTER_API_KEY'

  // Look up workspace + its bound Hermes container (Patch 14.2)
  const db = getDatabase()
  const ws = db.prepare(
    'SELECT id, slug, name, hermes_container FROM workspaces WHERE slug = ?'
  ).get(req.workspaceSlug) as
    | { id: number; slug: string; name: string; hermes_container: string | null }
    | undefined
  if (!ws) {
    return { ok: false, message: `Workspace not found: ${req.workspaceSlug}`, steps }
  }

  // Container resolution order (Patch 14): explicit request > workspace binding > sidecar default.
  // Customer-stack containers (customer-<slug>-hermes) host a single 'default' profile, so we
  // skip "name-spacing" the profile with the workspace slug there — the customer only ever sees
  // their own profile names.
  const container = req.hermesContainer || ws.hermes_container || 'hermes-agent'
  const isCustomerContainer = container !== 'hermes-agent'
  const profile = isCustomerContainer ? req.role : `${req.workspaceSlug}-${req.role}`

  // ── Step 1: hermes profile create ───────────────────────────────────────
  try {
    const r = await runCommand('docker', [
      'exec', container,
      'hermes', 'profile', 'create', profile, '--clone',
      '--description', `${req.role} for ${ws.name}`,
    ], { timeoutMs: 60_000 })
    const created = r.code === 0
    log('hermes profile create', created, (r.stdout || r.stderr || '').slice(0, 200))
    if (!created && !(r.stderr || '').match(/already exists/i)) {
      return { ok: false, message: 'Profile create failed', steps }
    }
  } catch (err: any) {
    log('hermes profile create', false, err?.message)
    return { ok: false, message: `Profile create error: ${err?.message}`, steps }
  }

  // ── Step 2: Write provider key into profile .env ────────────────────────
  // Build a small shell snippet to atomically rewrite the .env without that key.
  const safeKey = req.providerKey.replace(/'/g, "'\\''")
  const envScript = [
    `cd /opt/data/profiles/${profile}`,
    `grep -v '^${keyEnv}=' .env > .env.tmp 2>/dev/null || true`,
    `echo "${keyEnv}=${safeKey}" >> .env.tmp`,
    `mv .env.tmp .env`,
  ].join(' && ')

  try {
    const r = await runCommand('docker', ['exec', container, 'sh', '-c', envScript], { timeoutMs: 30_000 })
    log(`write ${keyEnv}`, r.code === 0, r.stderr?.slice(0, 200))
    if (r.code !== 0) {
      return { ok: false, message: 'Setting provider key failed', steps }
    }

    // Re-secure permissions
    await runCommand('docker', ['exec', container, 'chown', 'hermes:hermes', `/opt/data/profiles/${profile}/.env`], { timeoutMs: 10_000 })
    await runCommand('docker', ['exec', container, 'chmod', '600', `/opt/data/profiles/${profile}/.env`], { timeoutMs: 10_000 })
  } catch (err: any) {
    log(`write ${keyEnv}`, false, err?.message)
    return { ok: false, message: `Env write error: ${err?.message}`, steps }
  }

  // ── Step 3: Restart per-profile gateway ─────────────────────────────────
  try {
    const r = await runCommand('docker', ['exec', container, 'hermes', '-p', profile, 'gateway', 'restart'], { timeoutMs: 30_000 })
    log('gateway restart', r.code === 0, r.stdout?.slice(0, 200))
    // Non-fatal: gateway might already be running fine
  } catch (err: any) {
    log('gateway restart', false, err?.message)
    // Non-fatal — continue to DB registration
  }

  // ── Step 4: Insert agent row + wire to workspace ────────────────────────
  let agentId: number | undefined
  try {
    const now = Math.floor(Date.now() / 1000)
    const existing = db.prepare('SELECT id FROM agents WHERE name = ?').get(profile) as { id: number } | undefined
    if (existing) {
      db.prepare(
        'UPDATE agents SET role = ?, workspace_id = ?, status = ?, last_seen = ?, updated_at = ? WHERE id = ?'
      ).run(req.role, ws.id, 'idle', now, now, existing.id)
      agentId = existing.id
      log('db: agent updated', true, `id=${agentId}`)
    } else {
      const result = db.prepare(
        'INSERT INTO agents (name, role, status, workspace_id, last_seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(profile, req.role, 'idle', ws.id, now, now, now)
      agentId = Number(result.lastInsertRowid)
      log('db: agent inserted', true, `id=${agentId}`)
    }

    logAuditEvent({
      action: 'agent.provisioned',
      actor: req.actor,
      detail: JSON.stringify({
        profile,
        role: req.role,
        workspace_slug: ws.slug,
        workspace_id: ws.id,
        container,
      }),
    })
  } catch (err: any) {
    log('db: agent insert', false, err?.message)
    return { ok: false, message: `DB error: ${err?.message}`, steps }
  }

  return {
    ok: true,
    agentId,
    agentName: profile,
    message: `Agent ${profile} provisioned in ${ws.name}${isCustomerContainer ? ` (customer container: ${container})` : ''}`,
    steps,
  }
}

/**
 * Delete a Hermes profile by name (sidecar) — Patches 13 + 14.
 *
 * Stops the per-profile gateway then runs `hermes profile delete --yes`.
 * Safe to call for profiles that may not exist (returns ok=true so workspace
 * cleanup proceeds even if a profile was already removed manually).
 *
 * Patch 14: target container resolves from request override or, if the
 * profile name follows the "<workspace-slug>-<role>" convention, from the
 * matching workspace's hermes_container binding.
 */
export interface DeleteHermesProfileRequest {
  profileName: string
  hermesContainer?: string
}

export async function deleteHermesProfile(
  req: DeleteHermesProfileRequest
): Promise<{ ok: boolean; message: string }> {
  const profile = (req.profileName || '').trim()
  if (!profile || profile === 'default') {
    return { ok: false, message: 'Refusing to delete the default profile' }
  }
  if (!NAME_RE.test(profile)) {
    return { ok: false, message: `Invalid profile name: ${profile}` }
  }

  // Patch 14: figure out which container holds this profile.
  let container = req.hermesContainer || ''
  if (!container) {
    try {
      const db = getDatabase()
      // Look for a workspace whose slug is a prefix of the profile name (e.g.
      // 'digital-architekten' for profile 'digital-architekten-reviewer').
      const wsRows = db.prepare(
        'SELECT slug, hermes_container FROM workspaces WHERE hermes_container IS NOT NULL'
      ).all() as Array<{ slug: string; hermes_container: string | null }>
      const match = wsRows
        .filter(w => w.hermes_container)
        .sort((a, b) => b.slug.length - a.slug.length)
        .find(w => profile === w.slug || profile.startsWith(w.slug + '-'))
      if (match?.hermes_container) container = match.hermes_container
    } catch { /* fall back to default */ }
  }
  if (!container) container = 'hermes-agent'

  // In customer-stack containers the profile name is just the role (no
  // workspace prefix), so strip the prefix if our caller still passed the
  // fully-qualified MC convention.
  let targetProfile = profile
  if (container !== 'hermes-agent') {
    const dash = profile.indexOf('-')
    if (dash > 0) targetProfile = profile.slice(dash + 1)
  }

  try {
    // Stop the per-profile gateway (best-effort)
    await runCommand('docker', ['exec', container, 'hermes', '-p', targetProfile, 'gateway', 'stop'], { timeoutMs: 20_000 }).catch(() => undefined)

    const r = await runCommand('docker', ['exec', container, 'hermes', 'profile', 'delete', targetProfile, '--yes'], { timeoutMs: 60_000 })
    if (r.code !== 0) {
      const stderr = (r.stderr || '').toLowerCase()
      // "no such profile" is fine — workspace cleanup already partially done
      if (stderr.includes('not found') || stderr.includes('no such profile') || stderr.includes('does not exist')) {
        return { ok: true, message: `Profile ${targetProfile} already gone (${container})` }
      }
      return { ok: false, message: `Profile delete failed (exit ${r.code}, container=${container}): ${(r.stderr || r.stdout || '').slice(0, 200)}` }
    }
    return { ok: true, message: `Profile ${targetProfile} deleted from ${container}` }
  } catch (err: any) {
    return { ok: false, message: err?.message || 'docker exec failed' }
  }
}
