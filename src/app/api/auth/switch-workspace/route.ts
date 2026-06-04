/**
 * POST /api/auth/switch-workspace — Werwolf-Media fork Patch 12
 *
 * Lets the current operator hop between workspaces of the same tenant
 * without re-logging-in. Updates the active session row's workspace_id
 * (does NOT touch users.workspace_id, which remains the user's default).
 *
 * Body: { workspace_id: number }
 * Auth: any logged-in user (admin or above) — non-admins can only switch
 * to workspaces they belong to (currently: same tenant).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest, requireRole } from '@/lib/auth'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { logger } from '@/lib/logger'
import { getMcSessionCookieName } from '@/lib/session-cookie'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const user = auth.user

  // API-key clients can't switch — they should pass ?workspace_id= directly.
  if (user.id === 0) {
    return NextResponse.json(
      { error: 'API-key clients cannot switch workspace — pass ?workspace_id= on each request instead.' },
      { status: 400 },
    )
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const targetWorkspaceId = Number(body?.workspace_id)
  if (!Number.isFinite(targetWorkspaceId) || targetWorkspaceId <= 0) {
    return NextResponse.json({ error: 'workspace_id required (positive integer)' }, { status: 400 })
  }

  try {
    const db = getDatabase()
    const tenantId = user.tenant_id ?? 1
    const ws = db
      .prepare('SELECT id, slug, name, tenant_id FROM workspaces WHERE id = ?')
      .get(targetWorkspaceId) as { id: number; slug: string; name: string; tenant_id: number } | undefined

    if (!ws) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }

    // Non-admins are confined to their own tenant.
    if (user.role !== 'admin' && ws.tenant_id !== tenantId) {
      return NextResponse.json({ error: 'Workspace not in your tenant' }, { status: 403 })
    }

    const cookieName = getMcSessionCookieName()
    const token = request.cookies.get(cookieName)?.value
    if (!token) {
      // Without a session cookie we have nothing to update — the user is using
      // some other auth (e.g. proxy headers). Return success so the client can
      // proceed by sending ?workspace_id= explicitly.
      return NextResponse.json({
        ok: true,
        workspace: ws,
        note: 'No session cookie to update — pass workspace_id query param explicitly.',
      })
    }

    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'UPDATE user_sessions SET workspace_id = ?, updated_at = ? WHERE token = ? AND user_id = ?'
    ).run(ws.id, now, token, user.id)

    logAuditEvent({
      action: 'workspace.switched',
      actor: user.username,
      actor_id: user.id,
      target_type: 'workspace',
      target_id: ws.id,
      detail: { from: user.workspace_id, to: ws.id, slug: ws.slug },
    })

    return NextResponse.json({ ok: true, workspace: ws })
  } catch (err: any) {
    logger.error({ err }, 'POST /api/auth/switch-workspace failed')
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
