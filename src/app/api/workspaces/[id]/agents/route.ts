/**
 * POST /api/workspaces/[id]/agents — provision a new Hermes profile/agent
 * for an existing workspace.
 *
 * Werwolf-Media fork Patch 9.2.
 *
 * Body: { role: string, provider_key: string }
 * Returns: { agent: {...}, provisioned: {...steps...} }
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { provisionHermesAgent } from '@/lib/agent-provisioner'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { id } = await ctx.params
  const workspaceId = Number.parseInt(id, 10)
  if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
    return NextResponse.json({ error: 'Invalid workspace id' }, { status: 400 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const role = typeof body?.role === 'string' ? body.role.trim() : ''
  const providerKey = typeof body?.provider_key === 'string' ? body.provider_key.trim() : ''
  if (!role) return NextResponse.json({ error: 'role is required' }, { status: 400 })
  if (!providerKey) return NextResponse.json({ error: 'provider_key is required' }, { status: 400 })

  try {
    const db = getDatabase()
    const ws = db.prepare('SELECT id, slug, name FROM workspaces WHERE id = ?').get(workspaceId) as
      | { id: number; slug: string; name: string }
      | undefined
    if (!ws) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })

    const result = await provisionHermesAgent({
      workspaceSlug: ws.slug,
      role,
      providerKey,
      actor: auth.user.username,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.message, steps: result.steps }, { status: 400 })
    }

    return NextResponse.json(
      {
        agent: {
          id: result.agentId,
          name: result.agentName,
          role,
          workspace_id: ws.id,
          workspace_slug: ws.slug,
        },
        steps: result.steps,
        message: result.message,
      },
      { status: 201 }
    )
  } catch (err: any) {
    logger.error({ err, workspaceId }, 'POST /api/workspaces/[id]/agents failed')
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
