import { createSignal } from "solid-js"
import { onInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { normalizeTabViewState, type RestorableTabViewState } from "./tab-view-state-codec"
export type { RestorableTabViewState, RestorableTabPreview, RestorableTabMissionView } from "./tab-view-state-codec"

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
  const next = normalizeTabViewState({ ...getTabViewState(instanceId), ...patch })
  if (next) setStates(previous => new Map(previous).set(instanceId, next))
}

/** Seed once: repeated asynchronous session hydration must preserve local view gestures. */
export function seedTabViewState(instanceId: string, value: RestorableTabViewState | undefined): void {
  if (states().has(instanceId)) return
  const next = normalizeTabViewState(value) ?? { version: 1 as const }
  const reader = next.missions?.reader
  if (reader?.instanceId) reader.instanceId = instanceId
  if (reader?.recurrence) reader.recurrence.instanceId = instanceId
  setStates(previous => new Map(previous).set(instanceId, next))
}

export function clearTabViewState(instanceId: string): void {
  if (!states().has(instanceId)) return
  setStates(previous => { const next = new Map(previous); next.delete(instanceId); return next })
}

onInstanceLifecycleAuthority(event => {
  if (event.type === "removed") clearTabViewState(event.instanceId)
})
