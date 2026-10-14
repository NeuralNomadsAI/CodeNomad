import { createSignal } from "solid-js"

export interface MissionBriefingRequest {
  requestID: string
  state: "preparing" | "sending" | "admitted" | "uncertain" | "error"
  messageId?: string
  briefingId?: string
}
// Window-local instance/directory/project/mission/coordinator identity. No timers or replay.
const [requests, setRequests] = createSignal(new Map<string, MissionBriefingRequest>())
export function missionBriefingRequest(key: string) { return requests().get(key) }
export function setMissionBriefingRequest(key: string, request: MissionBriefingRequest) {
  setRequests(previous => new Map(previous).set(key, request))
}
