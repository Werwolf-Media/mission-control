'use client'

/**
 * Workspace Add-Agent Modal — Werwolf-Media fork Patch 9.3
 *
 * Adds a new Hermes profile/agent to an existing workspace.
 * POST /api/workspaces/[id]/agents.
 */

import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { useFocusTrap } from '@/lib/use-focus-trap'

const ROLES = ['coder', 'reviewer', 'researcher', 'tester', 'devops', 'assistant'] as const

interface Props {
  workspace: { id: number; slug: string; name: string }
  onClose: () => void
  onAdded: () => void
}

export function WorkspaceAddAgentModal({ workspace, onClose, onAdded }: Props) {
  const [role, setRole] = useState<typeof ROLES[number]>('coder')
  const [providerKey, setProviderKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [steps, setSteps] = useState<Array<{ step: string; ok: boolean; detail?: string }> | null>(null)

  const dialogRef = useFocusTrap(onClose)

  const submit = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    setSteps(null)
    try {
      const res = await apiFetch<Response>(`/api/workspaces/${workspace.id}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, provider_key: providerKey.trim() }),
        raw: true,
      })
      const data = await res.json() as any
      if (!res.ok) {
        setSteps(Array.isArray(data.steps) ? data.steps : null)
        throw new Error(data?.error || `HTTP ${res.status}`)
      }
      if (Array.isArray(data.steps)) setSteps(data.steps)
      setTimeout(() => onAdded(), 600)
    } catch (e: any) {
      setError(e?.message || 'Failed to add agent')
    } finally {
      setSubmitting(false)
    }
  }, [workspace.id, role, providerKey, onAdded])

  const newProfileName = `${workspace.slug}-${role}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-lg border border-border bg-card text-card-foreground shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="border-b border-border px-5 py-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Add agent to {workspace.name}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">×</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Role</span>
            <div className="flex flex-wrap gap-2 pt-2">
              {ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={`px-2.5 py-1 rounded-full text-xs border transition ${
                    role === r
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </label>

          <div>
            <span className="text-sm font-medium">New Hermes profile</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              <code>{newProfileName}</code>
            </p>
          </div>

          <label className="block">
            <span className="text-sm font-medium">OpenRouter API key <span className="text-red-400">*</span></span>
            <p className="text-xs text-muted-foreground mt-0.5">Costs from this agent will be billed against this key.</p>
            <input
              type="password"
              value={providerKey}
              onChange={(e) => setProviderKey(e.target.value)}
              placeholder="sk-or-v1-…"
              className="w-full bg-surface-1 text-foreground border border-border rounded-md px-3 py-2 text-sm font-mono text-sm mt-1"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </label>

          {error && (
            <div className="rounded border border-red-500/50 bg-red-500/10 text-red-200 p-2 text-xs">{error}</div>
          )}

          {steps && (
            <div className="rounded border border-border bg-muted/30 p-2 space-y-1 text-xs">
              {steps.map((s, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <span className={s.ok ? 'text-emerald-400' : 'text-red-400'}>{s.ok ? '✓' : '✗'}</span>
                  <span>{s.step}</span>
                  {s.detail && <span className="text-muted-foreground truncate">— {s.detail.slice(0, 80)}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-border px-5 py-3 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !providerKey.trim()}>
            {submitting ? 'Provisioning…' : 'Add agent'}
          </Button>
        </div>
      </div>
    </div>
  )
}
