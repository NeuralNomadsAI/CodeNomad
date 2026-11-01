import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { MissionControl } from "../../missions/control"
import type { MissionStorage } from "../../missions/journal"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { controlNativeMissionSchedule } from "./native-mission-schedule-control"
import { ownerFixture } from "./native-schedule-owner-test-fixture"

test("calendar controls preserve journal-bound preparation, coordinator identity and original creation receipt", async t => {
  const f = await ownerFixture(t), creationRequestID = "prepared_original"
  const storage: MissionStorage = { get: async key => structuredClone(f.values.get(key)),
    set: async (key, value, guard) => { guard?.(); f.values.set(key, structuredClone(value)) },
    scan: async ({ prefix }) => ({ entries: [...f.values].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: structuredClone(value) })) }) }
  const product = new MissionControl({ project: { id: "project", canonical: f.directory, location: { directory: f.directory } },
    storage, documents: use => use(f.store), documentReads: use => use(f.store), now: () => f.now,
    sessions: { get: async ({ sessionID }) => { const session = f.sessions.get(sessionID); assert.ok(session); return session },
      create: async input => { const session = { ...input, projectID: "project" }; f.sessions.set(input.id, session); return session },
      prompt: async () => assert.fail("preparation never prompts"), synthetic: async () => assert.fail("preparation never resumes") },
  })
  const mission = (await product.create({ requestID: creationRequestID, objective: "Original instructions", template: "custom" })).mission
  const id = mission.id, original = await f.store.read(id)
  assert.ok(original && !("deletedAt" in original) && original.oneTime)
  const configuration = original.configuration, coordinator = structuredClone(f.sessions.get(mission.coordinatorSessionId))
  assert.equal(mission.runState, "prepared"); assert.equal(original.firstPlayedAt, null)
  const before = canonicalAuthority([...f.values])
  // The two temporal representations and a text/profile change all require the
  // journal owner, even while its root has never been admitted.
  for (const candidate of [configuration, f.configuration, { ...configuration, title: "Edited title", objective: "Edited instructions",
    profiles: { coordinator: { agent: "other", model: { providerID: "fixture", id: "other" } } } }]) {
    const request = { missionID: id, requestID: "edit_original", expectedRevision: original.revision,
      action: "configure" as const, configuration: candidate }
    await assert.rejects(f.owner.prepareControl(request), /Use immediate Mission preparation/)
    await assert.rejects(f.owner.control(request), /Use immediate Mission preparation/)
    const authority = { request, store: f.store, current: f.current } as unknown as Parameters<typeof controlNativeMissionSchedule>[1]
    await assert.rejects(Effect.runPromise(Effect.scoped(controlNativeMissionSchedule(f.ctx, authority, undefined, Effect.runPromise))))
    assert.equal(canonicalAuthority([...f.values]), before)
    assert.deepEqual(await f.store.read(id), original)
    assert.deepEqual((await product.snapshot()).missions, [mission])
    assert.deepEqual(f.sessions.get(mission.coordinatorSessionId), coordinator)
    assert.deepEqual(f.calls, [])
    assert.equal(f.sessions.size, 1)
  }
})
