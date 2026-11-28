import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import { preparationFixture } from "./mission-preparation-test-fixture"
import { MissionJournal } from "./journal"
import { NativeMissionDocumentStore } from "./mission-document-store"
import { MissionCreationIntents } from "./creation-intent"
import { stableToken } from "./receipt-identity"

{
  for (const nextSource of [undefined, "msn_another_passage"]) {
    test(`a preparation stays deleted after compaction, source release to ${nextSource} and reconstruction`, async () => {
      const f = await preparationFixture()
      const author = "ses_author", source = "msn_source_passage"
      f.sessions.set(author, { id: author, projectID: "project", location: { directory: "/fixture" },
        metadata: { "codenomad.mission": { missionID: source, kind: "coordinator" } } })
      const selection = f.request.configuration.profiles.coordinator
      const request = { requestID: "original", objective: "Separate work", template: "custom" as const,
        profiles: { coordinator: selection, roles: { specialist: selection } }, taskMode: "native" as const }
      let sends = 0
      const control = () => {
        const store = new NativeMissionDocumentStore(f.storage, "project", "/fixture")
        return new MissionControl({ project: { id: "project", canonical: "/fixture", location: { directory: "/fixture" } },
          storage: f.storage, documents: use => use(store), documentReads: use => use(store),
          sessions: { get: async ({ sessionID }) => structuredClone(f.sessions.get(sessionID)!),
            create: async () => assert.fail("Only the creation owner creates coordinators"),
            prompt: async () => assert.fail("No prompt"), synthetic: async () => assert.fail("No input") },
          transport: { prompt: async () => {}, synthetic: async () => {}, prepare: async (sessionID, input) => {
            sends++
            const author = { coordinatorSessionID: sessionID, ...(input.missionID ? { missionID: input.missionID } : {}) }
            return f.control.create({ ...input, prepared: true, preparedBy: author })
          } },
        })
      }
      const first = await control().prepare(author, request)
      const id = first.mission.id
      const saved = await f.store.read(id)
      assert.ok(saved && !("deletedAt" in saved))
      await f.control.delete({ missionID: id, requestID: "delete_original", expectedRevision: first.mission.revision })
      await new MissionJournal(f.storage, "project", "/fixture").purgeDeleted({ all: true })
      const tombstone = await f.store.read(id)
      assert.ok(tombstone && "deletedAt" in tombstone)
      assert.deepEqual(tombstone.creation, { author: saved.creation!.author,
        requestID: saved.creation!.requestID, digest: saved.creation!.digest })
      // Replay must rely on the durable tombstone, after temporary choices are released.
      const journal = new MissionJournal(f.storage, "project", "/fixture")
      await new MissionCreationIntents(f.storage, journal.projectToken).settled(
        `msn_${stableToken(`project\0${saved.creation!.requestID}`, 24)}`)
      f.sessions.get(author)!.metadata = nextSource
        ? { "codenomad.mission": { missionID: nextSource, kind: "coordinator" } } : {}
      const rebuilt = control()
      await assert.rejects(rebuilt.prepare(author, request), { code: "mission-deleted" })
      assert.equal(sends, 1, "the deleted original never reaches creation again")
      assert.equal((await rebuilt.listMissions(author)).some(item => item.missionID === id), false, "tombstones stay absent from the project inventory")
      await rebuilt.prepare(author, { ...request, requestID: "another_request" })
      assert.equal(sends, 2, "a new request remains eligible after source release")
    })
  }
}
