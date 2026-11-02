import { NativeMissionDocumentStore } from "../../../server/src/missions/mission-document-store"
import { missionScheduleView } from "../../../server/src/missions/mission-schedule-view"
import type { MissionConfiguration } from "../../../server/src/missions/launch-policy"
import type { MissionJsonValue } from "../../../server/src/missions/model"

/** Strict real document projection for paused creation HTTP acknowledgements. */
export async function pausedMissionScheduleReceipt(input: Record<string, any>) {
  const values = new Map<string, MissionJsonValue>()
  const store = new NativeMissionDocumentStore({ get: async key => values.get(key),
    compareAndSet: async (key, value) => { values.set(key, value) } }, "project", "/fixture")
  const doc = await store.create("msn_created", { ...input.configuration, profileID: "profile", executionHost: "local",
    roots: [{ mode: "directory-only", directory: "/fixture" }] } as MissionConfiguration, Date.now(), () => true)
  const result = missionScheduleView(doc)
  return { ...result, pending: false, document: { ...result.document, control: {
    requestID: input.requestID, expectedRevision: input.expectedRevision, action: input.action, pending: false } } }
}
