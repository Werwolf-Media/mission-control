'use client'

/**
 * Workspace Create Modal — Werwolf-Media fork Patch 9.3
 *
 * One-call workspace + initial agents wizard. Posts to /api/workspaces
 * with provider_key + initial_agents[]; the backend provisions Hermes
 * profiles in the hermes-agent sidecar container and wires them to the
 * new workspace.
 */

import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { useFocusTrap } from '@/lib/use-focus-trap'

const ROLES = ['coder', 'reviewer', 'researcher', 'tester', 'devops', 'assistant'] as const

interface Props {
  onClose: () => void
  onCreated: (workspace: { id: number; slug: string }) => void
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function WorkspaceCreateModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false)
  const [providerKey, setProviderKey] = useState('')
  const [initialAgents, setInitialAgents] = useState<Set<string>>(new Set(['coder']))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stepResults, setStepResults] = useState<Array<{ role: string; ok: boolean; message: string }> | null>(null)

  const dialogRef = useFocusTrap(onClose)

  const effectiveSlug = slugManuallyEdited ? slug : slugify(name)

  const toggleRole = (role: string) => {
    setInitialAgents((prev) => {
      const next = new Set(prev)
      if (next.has(role)) next.delete(role)
      else next.add(role)
      return next
    })
  }

  const submit = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    setStepResults(null)
    try {
      const body: any = {
        name: name.trim(),
        slug: effectiveSlug,
      }
      if (providerKey.trim()) body.provider_key = providerKey.trim()
      if (initialAgents.size > 0 && providerKey.trim()) {
        body.initial_agents = Array.from(initialAgents)
      }

      const res = await apiFetch<Response>('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        raw: true,
      })
      const data = await res.json() as any
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)

      if (Array.isArray(data.provisioned) && data.provisioned.length > 0) {
        setStepResults(data.provisioned.map((p: any) => ({
          role: p.role,
          ok: !!p.ok,
          message: p.message || '',
        })))
        const allOk = data.provisioned.every((p: any) => p.ok)
        if (allOk) {
          setTimeout(() => onCreated(data.workspace), 800)
        }
      } else {
        onCreated(data.workspace)
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to create workspace')
    } finally {
      setSubmitting(false)
    }
  }, [name, effectiveSlug, providerKey, initialAgents, onCreated])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        ref={dialogRef}
        className="w-full max-w-lg rounded-lg border border-border bg-card text-card-foreground shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="border-b border-border px-5 py-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Create Workspace</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">×</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <Field label="Display name" required>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mueller GmbH"
              className="w-full bg-surface-1 text-foreground border border-border rounded-md px-3 py-2 text-sm"
            />
          </Field>

          <Field label="Slug" hint="Used for the Hermes profile prefix">
            <input
              type="text"
              value={effectiveSlug}
              onChange={(e) => { setSlug(e.target.value); setSlugManuallyEdited(true) }}
              placeholder="auto-derived from name"
              className="w-full bg-surface-1 text-foreground border border-border rounded-md px-3 py-2 text-sm font-mono text-sm"
            />
          </Field>

          <Field label="OpenRouter API key" hint="Required if you want to provision agents now. Leave blank to create an empty workspace.">
            <input
              type="password"
              value={providerKey}
              onChange={(e) => setProviderKey(e.target.value)}
              placeholder="sk-or-v1-…"
              className="w-full bg-surface-1 text-foreground border border-border rounded-md px-3 py-2 text-sm font-mono text-sm"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field label="Initial agents" hint="Each becomes a Hermes profile with its own state.db">
            <div className="flex flex-wrap gap-2 pt-1">
              {ROLES.map((r) => {
                const active = initialAgents.has(r)
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => toggleRole(r)}
                    disabled={!providerKey.trim()}
                    className={`px-2.5 py-1 rounded-full text-xs border transition ${
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card border-border text-muted-foreground hover:text-foreground'
                    } ${!providerKey.trim() ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {r}
                  </button>
                )
              })}
            </div>
            {!providerKey.trim() && (
              <p className="text-xs text-muted-foreground mt-1">Enter a provider key to enable agent selection.</p>
            )}
          </Field>

          {error && (
            <div className="rounded border border-red-500/50 bg-red-500/10 text-red-200 p-2 text-xs">{error}</div>
          )}

          {stepResults && (
            <div className="rounded border border-border bg-muted/30 p-2 space-y-1 text-xs">
              {stepResults.map((r) => (
                <div key={r.role} className="flex items-start gap-2">
                  <span className={r.ok ? 'text-emerald-400' : 'text-red-400'}>{r.ok ? '✓' : '✗'}</span>
                  <span className="font-mono">{r.role}</span>
                  <span className="text-muted-foreground truncate">{r.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-border px-5 py-3 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !name.trim() || !effectiveSlug}>
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">
        {label} {required && <span className="text-red-400">*</span>}
      </span>
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      <div className="mt-1">{children}</div>
    </label>
  )
}
