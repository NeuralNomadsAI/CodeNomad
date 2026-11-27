import { createSignal } from "solid-js"
import type { MissionConfiguration } from "../../../server/src/missions/launch-policy"
import type { MissionPanelMap, MissionScheduleRead } from "../../../server/src/api-types"
import type { MissionScheduleControlReceipt } from "../lib/mission-schedule-receipt"
import type { MissionEditorDraft } from "./mission-editor-state"

export type MissionEditorConfiguration = Omit<MissionConfiguration, "roots" | "profileID" | "executionHost">
export interface MissionScheduleEditorRequest {
  missionID?: string; requestID: string; expectedRevision: number; action: "create" | "configure"
  directory?: string; configuration: MissionEditorConfiguration
  retry?: boolean
}
export interface MissionJournalEditRequest {
  missionID: string; requestID: string; expectedRevision: number; objective: string; notes: string
}
interface Hold {
  readonly payload: string
  readonly draft: MissionEditorDraft
  readonly state: "pending" | "uncertain"
}
// Window memory, shared by every mounting. Serialized intent is immutable even
// when the editor that submitted it has gone away. No automatic replay.
const [holds, setHolds] = createSignal<ReadonlyMap<string, Hold>>(new Map())
export const missionScheduleEditorHold = (scope: string) => holds().get(scope)
export function holdMissionScheduleEditor(scope: string, request: MissionScheduleEditorRequest | MissionJournalEditRequest, draft: MissionEditorDraft) {
  if (holds().has(scope)) return false
  setHolds(value => new Map(value).set(scope, { payload: JSON.stringify(request), draft: structuredClone(draft), state: "pending" }))
  return true
}
export function retainMissionScheduleEditor(scope: string, requestID: string) {
  const held = holds().get(scope)
  if (!held || JSON.parse(held.payload).requestID !== requestID) return
  setHolds(value => new Map(value).set(scope, { ...held, state: "uncertain" }))
}
export function resumeMissionScheduleEditor(scope: string, requestID: string) {
  const held = holds().get(scope)
  if (!held || held.state !== "uncertain" || JSON.parse(held.payload).requestID !== requestID) return false
  setHolds(value => new Map(value).set(scope, { ...held, state: "pending" }))
  return true
}
export type MissionScheduleEditorSettled = { mission?: MissionPanelMap; scheduleID?: string }
const settledListeners = new Map<string, Set<(requestID: string, settled: MissionScheduleEditorSettled) => boolean>>()
export function onMissionScheduleEditorSettled(scope: string, listener: (requestID: string, settled: MissionScheduleEditorSettled) => boolean) {
  let set = settledListeners.get(scope)
  if (!set) settledListeners.set(scope, set = new Set())
  set.add(listener)
  return () => { set.delete(listener); if (!set.size) settledListeners.delete(scope) }
}
export function releaseMissionScheduleEditor(scope: string, requestID: string, settled?: MissionScheduleEditorSettled) {
  const held = holds().get(scope)
  if (!held || JSON.parse(held.payload).requestID !== requestID) return false
  setHolds(value => { const next = new Map(value); next.delete(scope); return next })
  if (!settled) return false
  for (const listener of [...(settledListeners.get(scope) ?? [])]) {
    if (listener(requestID, settled)) return true
  }
  return false
}
/** Only a positive receipt of the original tuple releases a dispatched write. */
export function exactMissionScheduleEditorReceipt(request: MissionScheduleEditorRequest, result: MissionScheduleRead | MissionScheduleControlReceipt) {
  const doc = result?.document, receipt = doc?.control
  return !!doc && (!request.missionID || doc.id === request.missionID) && result.pending === false
    && receipt?.requestID === request.requestID && receipt.action === request.action
    && receipt.expectedRevision === request.expectedRevision && receipt.pending === false
}
