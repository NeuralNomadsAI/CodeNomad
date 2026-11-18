import type { RestorableSessionState } from "./client-state-codec"
import { normalizeRestorableSession } from "./client-state-codec"
import { normalizeWorkspacePath } from "./app-session-reconciliation"
import { normalizeTabViewState, parseLegacySessionPreviews, type RestorableTabPreview } from "./tab-view-state-codec"

/** Stable compact identities shared by saved Mission views, disclosures and acknowledgements. */
export function compactMissionKey(value: string): string {
  let a = 2166136261, b = 5381
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619)
    b = Math.imul(b, 33) ^ value.charCodeAt(i)
  }
  return btoa(String.fromCharCode(a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255,
    b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function readLegacyMissionView(folder: string, read: (key: string) => string | null) {
  const key = `mission-project-${compactMissionKey(folder)}`, source = read(key)
  if (!source || source.length > 4096) return
  try {
    const view = normalizeTabViewState({ version: 1, missions: JSON.parse(source) })
    if (view?.missions) return { key, source, view }
  } catch { /* Ignore malformed saved layout. */ }
}

/** Descriptor order owns project-wide adoption; session entries copy to each matching occurrence. */
export function migrateLegacyTabPreviews(state: RestorableSessionState | null, value: string | null,
  readLayout: (key: string) => string | null = () => null) {
  const entries = parseLegacySessionPreviews(value)
  const remaining = new Map(entries)
  if (!state) return null
  const adoptedProjects = new Set<string>()
  const adoptedMissions = new Set<string>(), missions: Array<{ key: string; source: string }> = []
  const tabs = state.tabs.map(tab => {
    if (tab.kind !== "workspace") return tab
    const folder = normalizeWorkspacePath(tab.folder)
    const legacyMission = adoptedMissions.has(folder) ? undefined : readLegacyMissionView(tab.folder, readLayout)
    adoptedMissions.add(folder)
    if (legacyMission) missions.push({ key: legacyMission.key, source: legacyMission.source })
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
    return tab.viewState || !legacyMission && !Object.keys(previews).length ? tab : {
      ...tab, viewState: { version: 1 as const, ...(Object.keys(previews).length ? { previews } : {}),
        ...(legacyMission ? { missions: legacyMission.view.missions } : {}) },
    }
  })
  if (remaining.size === entries.length && !missions.length) return null
  return { state: normalizeRestorableSession({ ...state, tabs })!, remaining: JSON.stringify(Object.fromEntries(remaining)), missions }
}
