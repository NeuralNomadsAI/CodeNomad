import { createSignal } from "solid-js"
import type { MissionEditorDraft } from "./mission-editor-state"

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
export function holdMissionScheduleEditor(scope: string, request: MissionJournalEditRequest, draft: MissionEditorDraft) {
  if (holds().has(scope)) return false
  setHolds(value => new Map(value).set(scope, { payload: JSON.stringify(request), draft: structuredClone(draft), state: "pending" }))
  return true
}
export function retainMissionScheduleEditor(scope: string, requestID: string) {
  const held = holds().get(scope)
  if (!held || JSON.parse(held.payload).requestID !== requestID) return
  setHolds(value => new Map(value).set(scope, { ...held, state: "uncertain" }))
}
export function releaseMissionScheduleEditor(scope: string, requestID: string) {
  const held = holds().get(scope)
  if (!held || JSON.parse(held.payload).requestID !== requestID) return
  setHolds(value => { const next = new Map(value); next.delete(scope); return next })
}
