import type { RestorableSessionState } from "./client-state-codec"
import { normalizeRestorableSession } from "./client-state-codec"
import { normalizeWorkspacePath } from "./app-session-reconciliation"
import { parseLegacySessionPreviews, type RestorableTabPreview } from "./tab-view-state-codec"

/** Descriptor order owns project-wide adoption; session entries copy to each matching occurrence. */
export function migrateLegacyTabPreviews(state: RestorableSessionState | null, value: string | null) {
  const entries = parseLegacySessionPreviews(value)
  const remaining = new Map(entries)
  if (!state || !remaining.size) return null
  const adoptedProjects = new Set<string>()
  const tabs = state.tabs.map(tab => {
    if (tab.kind !== "workspace") return tab
    const previews: Record<string, RestorableTabPreview> = {}
    for (const [key, preview] of entries) {
      let folder = key, sessionId: string | undefined
      try {
        const tuple: unknown = JSON.parse(key)
        if (Array.isArray(tuple) && tuple.length === 2 && tuple.every(part => typeof part === "string")) {
          [folder, sessionId] = tuple
        }
      } catch { /* A project-wide key is a plain folder path. */ }
      if (normalizeWorkspacePath(folder) !== normalizeWorkspacePath(tab.folder)) continue
      const projectWide = sessionId === undefined
      if (projectWide) {
        if (adoptedProjects.has(key)) continue
        sessionId = tab.activeSessionId === "info" ? tab.activeParentSessionId : tab.activeSessionId ?? tab.activeParentSessionId
        if (!sessionId) continue
        adoptedProjects.add(key)
      }
      // A versioned envelope is authoritative, including an explicit empty/chat view.
      if (!tab.viewState && sessionId) {
        if (projectWide) previews[sessionId] ??= preview
        else previews[sessionId] = preview
      }
      remaining.delete(key)
    }
    return tab.viewState || !Object.keys(previews).length ? tab : { ...tab, viewState: { version: 1 as const, previews } }
  })
  if (remaining.size === entries.length) return null
  return { state: normalizeRestorableSession({ ...state, tabs })!, remaining: JSON.stringify(Object.fromEntries(remaining)) }
}
