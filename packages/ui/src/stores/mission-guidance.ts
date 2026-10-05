import { createSignal } from "solid-js"

export interface MissionGuidanceDraft {
  text: string
  state: "draft" | "preparing" | "sending" | "admitted" | "uncertain" | "error"
  messageId?: string
}
// Instance/project/mission/coordinator identity, not snapshot identity. Drafts
// survive navigation and remount; no secrets or mission notes are copied here.
const [drafts, setDrafts] = createSignal(new Map<string, MissionGuidanceDraft>())
export function missionGuidanceDraft(key: string): MissionGuidanceDraft {
  return drafts().get(key) ?? { text: "", state: "draft" }
}
export function setMissionGuidanceDraft(key: string, value: MissionGuidanceDraft): void {
  setDrafts(previous => new Map(previous).set(key, value))
}
