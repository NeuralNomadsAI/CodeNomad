import assert from "node:assert/strict"
import test from "node:test"
import { preparationFixture } from "./mission-preparation-test-fixture"
import { prepareMissionDocumentDeletion, finishMissionDocumentDeletion } from "./mission-document-deletion"
import { MissionControlError } from "./control-error"

test("document deletion only reconciles the original request, revision and option, including after compaction", async () => {
  const f = await preparationFixture(), current = () => true as const
  const access = <T>(use: (store: typeof f.store) => Promise<T>) => use(f.store)
  const input = { missionID: f.mission.id, requestID: "original-delete", expectedRevision: f.mission.revision, deleteManagedSessions: false }
  await prepareMissionDocumentDeletion(access, access, input, Date.now(), current, true)
  for (const compacted of [false, true]) {
    if (compacted) await finishMissionDocumentDeletion(access, access, input, Date.now(), current, true)
    const saved = await f.store.read(f.mission.id)
    for (const changed of [{ requestID: "other" }, { expectedRevision: input.expectedRevision + 1 }, { deleteManagedSessions: true }]) {
      await assert.rejects(prepareMissionDocumentDeletion(access, access, { ...input, ...changed }, Date.now(), current, true),
        (error: unknown) => error instanceof MissionControlError && error.code === "request-conflict")
      assert.deepEqual(await f.store.read(f.mission.id), saved)
    }
    await prepareMissionDocumentDeletion(access, access, input, Date.now(), current, true)
    assert.deepEqual(await f.store.read(f.mission.id), saved)
  }
})
