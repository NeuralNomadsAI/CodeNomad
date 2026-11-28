import { createSignal } from "solid-js"
import { onInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { normalizeTabViewState, tabPreviewModes, type RestorableTabViewState } from "./tab-view-state-codec"
import { bindLocalTabView, saveLocalTabView, unbindLocalTabView, adoptLocalLegacyPreview, retireLocalLegacyPreview } from "./tab-view-state-local"
import { importSessionBrowsers } from "./session-browser-persistence"
import { parseInstanceKey } from "../lib/backend-identity"
export type { RestorableTabViewState, RestorableTabMissionView } from "./tab-view-state-codec"

const empty: RestorableTabViewState = { version: 1 }
const [states, setStates] = createSignal<ReadonlyMap<string, RestorableTabViewState>>(new Map())

/** The backend instance UUID identifies one tab occurrence, including duplicate folders. */
export function getTabViewState(instanceId: string): RestorableTabViewState {
  return states().get(instanceId) ?? empty
}

/** Undefined permits partial-restore preservation until this occurrence is seeded. */
export function captureTabViewState(instanceId: string): RestorableTabViewState | undefined {
  return states().get(instanceId)
}

export function updateTabViewState(instanceId: string, patch: Partial<Omit<RestorableTabViewState, "version">>): void {
  const current = getTabViewState(instanceId)
  if (Object.entries(patch).every(([key, value]) => current[key as keyof RestorableTabViewState] === value)) return
  // Live identities fence pending reader actions. Sanitize and budget at capture/restore.
  setStates(previous => new Map(previous).set(instanceId, { ...current, ...patch }))
  saveLocalTabView(instanceId, states().get(instanceId))
}

export function adoptLegacyTabPreview(instanceId: string, sessionId: string): void {
  const previews = getTabViewState(instanceId).previews
  if (previews?.[sessionId] !== undefined) return
  const legacy = adoptLocalLegacyPreview(instanceId, sessionId)
  if (legacy) {
    const imported = parseInstanceKey(instanceId).backendId === "local" && importSessionBrowsers([legacy.view])
    updateTabViewState(instanceId, { previews: { ...previews, ...(imported ? tabPreviewModes(legacy.view) : legacy.view).previews } })
    if (saveLocalTabView(instanceId, getTabViewState(instanceId))) retireLocalLegacyPreview(legacy)
  }
}

/** Seed once: repeated asynchronous session hydration must preserve local view gestures. */
export function seedTabViewState(instanceId: string, value: RestorableTabViewState | undefined): void {
  if (states().has(instanceId)) return
  const normalized = normalizeTabViewState(value) ?? { version: 1 as const }
  const next = parseInstanceKey(instanceId).backendId === "local" && importSessionBrowsers([normalized]) ? tabPreviewModes(normalized) : normalized
  setStates(previous => new Map(previous).set(instanceId, next))
}

export function clearTabViewState(instanceId: string): void {
  if (!states().has(instanceId)) return
  setStates(previous => { const next = new Map(previous); next.delete(instanceId); return next })
}

onInstanceLifecycleAuthority(event => {
  if (event.type === "opened") {
    const local = bindLocalTabView(event.instanceId, event.folder)
    if (local) seedTabViewState(event.instanceId, local)
  }
  if (event.type === "removed") {
    saveLocalTabView(event.instanceId)
    unbindLocalTabView(event.instanceId)
    clearTabViewState(event.instanceId)
  }
})
