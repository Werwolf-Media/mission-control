'use client'

/**
 * Workspace Switcher — Werwolf-Media fork Patch 12
 *
 * Header dropdown for hopping between workspaces of the active tenant.
 * Calls POST /api/auth/switch-workspace which updates the session row's
 * workspace_id; we then force a full reload so server-rendered panels
 * pick up the new scope.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'

interface Workspace {
  id: number
  slug: string
  name: string
}

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Fetch workspaces and current active id
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await apiFetch<{
          workspaces: Workspace[]
          active_workspace_id?: number | null
        }>('/api/workspaces')
        if (cancelled) return
        const list = (data.workspaces ?? []).slice().sort((a, b) => a.id - b.id)
        setWorkspaces(list)
        setActiveId(data.active_workspace_id ?? null)
      } catch {
        // non-critical — switcher just won't render
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const switchTo = useCallback(async (ws: Workspace) => {
    if (ws.id === activeId) {
      setOpen(false)
      return
    }
    setSwitching(ws.id)
    setError(null)
    try {
      const res = await apiFetch<Response>('/api/auth/switch-workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: ws.id }),
        raw: true,
      })
      const data = await res.json() as any
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      // Server-rendered panels rely on the cookie session — full reload picks
      // up the new workspace_id everywhere consistently.
      window.location.reload()
    } catch (e: any) {
      setError(e?.message || 'Switch failed')
      setSwitching(null)
    }
  }, [activeId])

  if (workspaces.length === 0) return null

  const activeWs = workspaces.find(w => w.id === activeId)
  const label = activeWs?.name ?? 'Workspace'

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="hidden md:flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary/40 text-2xs hover:bg-secondary/70 transition"
        title="Switch workspace"
      >
        <span className="text-muted-foreground">WS</span>
        <span className="text-muted-foreground/40">/</span>
        <span className="font-medium text-foreground truncate max-w-[180px]">{label}</span>
        <span className="text-muted-foreground/60 ml-0.5">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 min-w-[220px] rounded-md border border-border bg-popover shadow-lg overflow-hidden">
          <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
            Switch workspace
          </div>
          <ul className="max-h-[280px] overflow-y-auto">
            {workspaces.map((ws) => {
              const isActive = ws.id === activeId
              const isBusy = switching === ws.id
              return (
                <li key={ws.id}>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => switchTo(ws)}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-secondary/60 ${
                      isActive ? 'bg-secondary/30 text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${isActive ? 'bg-emerald-400' : 'bg-zinc-500/60'}`} />
                    <span className="flex-1 truncate">{ws.name}</span>
                    {isBusy && <span className="text-muted-foreground">…</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          {error && (
            <div className="px-3 py-2 text-2xs text-red-300 border-t border-border bg-red-500/5">{error}</div>
          )}
        </div>
      )}
    </div>
  )
}
