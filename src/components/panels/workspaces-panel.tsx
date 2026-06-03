'use client'

/**
 * Workspaces Panel — Werwolf-Media fork Patch 9.3
 *
 * Manage tenant workspaces + their Hermes agents.
 * - Lists workspaces with agent counts
 * - "+ Create Workspace" opens a modal that creates the workspace and
 *   provisions initial agents in one call (POST /api/workspaces with
 *   provider_key + initial_agents).
 * - Each workspace row has "+ Add Agent" which calls
 *   POST /api/workspaces/[id]/agents.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { WorkspaceCreateModal } from '@/components/modals/workspace-create-modal'
import { WorkspaceAddAgentModal } from '@/components/modals/workspace-add-agent-modal'

interface Workspace {
  id: number
  slug: string
  name: string
  tenant_id?: number | null
  created_at?: number
  updated_at?: number
}

interface Agent {
  id: number
  name: string
  role: string
  workspace_id?: number | null
  status?: string
}

export function WorkspacesPanel() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [agentsByWorkspace, setAgentsByWorkspace] = useState<Record<number, Agent[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [addAgentFor, setAddAgentFor] = useState<Workspace | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const wsRes = await apiFetch('/api/workspaces')
      if (!wsRes.ok) throw new Error(`Workspaces ${wsRes.status}`)
      const wsData = await wsRes.json() as { workspaces: Workspace[] }
      const ws = (wsData.workspaces ?? []).slice().sort((a, b) => a.id - b.id)
      setWorkspaces(ws)

      // Fetch agents — single call, group client-side by workspace_id
      const agRes = await apiFetch('/api/agents?limit=200')
      if (agRes.ok) {
        const agData = await agRes.json() as { agents: Agent[] }
        const grouped: Record<number, Agent[]> = {}
        for (const a of agData.agents ?? []) {
          const wsId = a.workspace_id ?? 0
          grouped[wsId] = grouped[wsId] ?? []
          grouped[wsId].push(a)
        }
        setAgentsByWorkspace(grouped)
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load workspaces')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Workspaces</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Multi-tenant client workspaces. Each workspace gets its own Hermes profiles —
            isolated memory, isolated provider keys.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Create Workspace</Button>
      </div>

      {error && (
        <div className="rounded border border-red-500/50 bg-red-500/10 text-red-200 p-3 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="space-y-4">
          {workspaces.length === 0 && (
            <div className="text-sm text-muted-foreground">No workspaces yet. Create the first one.</div>
          )}
          {workspaces.map((ws) => {
            const agents = agentsByWorkspace[ws.id] ?? []
            return (
              <div key={ws.id} className="rounded-lg border border-border bg-card/30 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-medium truncate">{ws.name}</h2>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      <code>{ws.slug}</code> · ws_id <code>{ws.id}</code> · {agents.length} agent{agents.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setAddAgentFor(ws)}>
                    + Add Agent
                  </Button>
                </div>

                {agents.length > 0 && (
                  <ul className="mt-3 space-y-1.5 text-sm">
                    {agents
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((a) => (
                        <li key={a.id} className="flex items-center gap-2">
                          <span className={`inline-block h-2 w-2 rounded-full ${a.status === 'idle' || a.status === 'online' ? 'bg-emerald-500' : 'bg-zinc-500'}`} />
                          <code className="font-mono text-xs">{a.name}</code>
                          <span className="text-xs text-muted-foreground">— {a.role}</span>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}

      {showCreate && (
        <WorkspaceCreateModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); refresh() }}
        />
      )}

      {addAgentFor && (
        <WorkspaceAddAgentModal
          workspace={addAgentFor}
          onClose={() => setAddAgentFor(null)}
          onAdded={() => { setAddAgentFor(null); refresh() }}
        />
      )}
    </div>
  )
}
