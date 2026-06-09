import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { listWorkspacesForTenant } from '@/lib/workspaces'
import { provisionHermesAgent } from '@/lib/agent-provisioner'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const tenantId = auth.user.tenant_id ?? 1
    const workspaces = listWorkspacesForTenant(db, tenantId)
    return NextResponse.json({
      workspaces,
      active_workspace_id: auth.user.workspace_id,
      tenant_id: tenantId,
    })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch workspaces' }, { status: 500 })
  }
}

/**
 * POST /api/workspaces - Create a new workspace
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const tenantId = auth.user.tenant_id ?? 1
    const body = await request.json()
    const { name, slug } = body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const resolvedSlug = (slug || name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

    if (!resolvedSlug) {
      return NextResponse.json({ error: 'Invalid slug' }, { status: 400 })
    }

    // Check uniqueness
    const existing = db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(resolvedSlug)
    if (existing) {
      return NextResponse.json({ error: 'Workspace slug already exists' }, { status: 409 })
    }

    // Werwolf-Media fork Patch 14: bind workspace to a Hermes container.
    // Body can include hermes_container=<container-name> (or null = MC's
    // internal sidecar). Accept the convenience "auto" which probes for a
    // matching customer-stack container by slug.
    let hermesContainer: string | null = null
    const containerArg = typeof body?.hermes_container === 'string' ? body.hermes_container.trim() : ''
    if (containerArg === 'auto' || containerArg === '') {
      // try the conventional customer-<slug>-hermes name first; we can't probe
      // docker here, so just record the convention — provisioner will fall back
      // gracefully if it doesn't exist.
      hermesContainer = null
    } else if (containerArg === 'sidecar' || containerArg === 'mc' || containerArg === 'hermes-agent') {
      hermesContainer = 'hermes-agent'
    } else {
      hermesContainer = containerArg
    }

    const now = Math.floor(Date.now() / 1000)
    const result = db.prepare(
      'INSERT INTO workspaces (slug, name, tenant_id, hermes_container, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(resolvedSlug, name.trim(), tenantId, hermesContainer, now, now)

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(result.lastInsertRowid)

    logAuditEvent({
      action: 'workspace_created',
      actor: auth.user.username,
      actor_id: auth.user.id,
      target_type: 'workspace',
      target_id: Number(result.lastInsertRowid),
      detail: { name: name.trim(), slug: resolvedSlug, hermes_container: hermesContainer },
    })

    // Werwolf-Media fork Patch 9.2: optional initial agents.
    // Body can include { provider_key, initial_agents: ['coder','reviewer',...] }
    // For each role, provision a Hermes profile and register it as an agent
    // bound to the freshly-created workspace.
    const providerKey = typeof body?.provider_key === 'string' ? body.provider_key.trim() : ''
    const initialRoles = Array.isArray(body?.initial_agents)
      ? body.initial_agents.filter((r: any) => typeof r === 'string')
      : []

    const provisioned: Array<{ role: string; ok: boolean; agentId?: number; message: string }> = []
    if (providerKey && initialRoles.length > 0) {
      for (const role of initialRoles) {
        try {
          const res = await provisionHermesAgent({
            workspaceSlug: resolvedSlug,
            role,
            providerKey,
            actor: auth.user.username,
          })
          provisioned.push({ role, ok: res.ok, agentId: res.agentId, message: res.message })
        } catch (err: any) {
          provisioned.push({ role, ok: false, message: err?.message || 'provision error' })
        }
      }
    }

    return NextResponse.json({ workspace, provisioned }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/workspaces error')
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 })
  }
}
