import assert from "node:assert/strict"
import test from "node:test"
import { MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"
import { controlMission } from "./lifecycle"
import { compareEvents, type MissionEvent, type MissionJsonValue } from "./model"
import { deleteMission } from "./session-cleanup"
import { missionTaskSessionID } from "./session-identity"

const missionID = "msn_fixture", projectID = "test-project", location = { directory: "/fixture" }

function fixture(specialists: number) {
  const events = new Map<string, MissionEvent>()
  const seed = (event: MissionEvent) => { assert.ok(parseMissionEvent(event)); events.set(event.id, event) }
  const base = { version: 1 as const, missionID, projectID }
  const creation = { ...base, id: "evt_create", type: "mission.created" as const, createdAt: 1,
    projectCanonical: location.directory, objective: "Target bound", template: "custom" as const,
    coordinator: { sessionID: "ses_coordinator", title: "Coordinator", location } }
  seed(creation)
  for (let i = 0; i < specialists; i++) {
    const taskID = `task_${i}`, key = `worker-${i}`, createdAt = 2 + 2 * i
    seed({ ...base, id: `evt_task_${i}`, type: "task.created", createdAt,
      task: { id: taskID, key, title: key, brief: "Synthetic task", role: "worker", blockedBy: [] } })
    seed({ ...base, id: `evt_dispatch_${i}`, type: "task.dispatching", createdAt: createdAt + 1,
      taskKey: key, actor: { sessionID: missionTaskSessionID(missionID, taskID, createdAt), title: key, location, managed: true },
      admissionID: `adm_${i}`, delivery: "queue" })
  }

  const intents: MissionEvent[] = []
  const storage: MissionStorage = {
    async get(key) { return events.get(key.split("/").at(-1)!) as unknown as MissionJsonValue | undefined },
    async set(_, value) {
      const event = parseMissionEvent(value)
      assert.ok(event)
      intents.push(event)
      events.set(event.id, event)
    },
    async scan() { throw new Error("Unexpected generic scan") },
    range: {
      listRanges: async () => ({ missionIDs: [missionID], stray: 0 }),
      readOrdered: async (_, visit, prepare, cachedDigest) => {
        const observation = { digest: String(events.size), rows: events.size, bytes: 0, discardedEvents: 0 }
        if (observation.digest !== cachedDigest && (prepare?.(observation, creation) ?? true)) {
          const ordered = [...events.values()].sort(compareEvents)
          for (let i = 0; i < ordered.length; i += 128) visit(ordered.slice(i, i + 128), events, new Map())
        }
        return observation
      },
      readEvent: async (_, id) => events.get(id),
    },
  }
  return { intents, journal: new MissionJournal(storage, projectID, location.directory) }
}

test("qualified long journal admits the 2000th actor, but not a concurrent 2001st", async () => {
  const { journal, intents } = fixture(1_998)
  const { revision } = (await journal.snapshot()).missions[0]
  assert.ok(revision > 2_000)
  const base = { version: 1 as const, missionID, projectID }
  for (const [i, key] of ["last", "overflow", "reuse"].entries()) {
    await journal.append({ ...base, id: `evt_boundary_task_${key}`, createdAt: revision + 1 + i, type: "task.created",
      task: { id: `task_boundary_${key}`, key, title: key, brief: "Synthetic task", role: "worker", blockedBy: [] } })
  }
  intents.length = 0
  const dispatch = (suffix: string, sessionID: string, i: number): MissionEvent => ({
    ...base, id: `evt_boundary_${suffix}`, createdAt: revision + 4 + i,
    type: "task.dispatching", taskKey: suffix, actor: { sessionID, title: suffix, location, managed: true },
    admissionID: `adm_boundary_${suffix}`, delivery: "queue",
  })
  const last = dispatch("last", "ses_last", 0), overflow = dispatch("overflow", "ses_overflow", 1)
  await journal.assertCanAppend(last)
  await journal.assertCanAppend(overflow) // both saw the same last available slot
  const results = await Promise.allSettled([journal.append(last), journal.append(overflow)])
  assert.equal(results[0].status, "fulfilled")
  assert.equal(results[1].status, "rejected")
  if (results[1].status === "rejected") assert.match(String(results[1].reason), /2000-actor safety limit/)
  await assert.rejects(journal.assertCanAppend(overflow), /2000-actor safety limit/)
  assert.equal(await journal.event(missionID, overflow.id), undefined)
  await journal.append(last) // exact replay
  const reuse = dispatch("reuse", missionTaskSessionID(missionID, "task_0", 2), 2)
  await journal.assertCanAppend(reuse)
  await journal.append(reuse)
  assert.deepEqual(intents.map(event => event.id), [last.id, reuse.id])
  assert.equal((await journal.snapshot()).missions[0].actors.length, 2_000)
})

for (const action of ["stop", "cleanup"] as const) {
  for (const targets of [2_000, 2_001]) {
    test(`${action} with ${targets} native targets: intent preflight is independent of journal length`, async () => {
      const { journal, intents } = fixture(targets - (action === "stop" ? 1 : 0))
      const snapshot = await journal.snapshot()
      assert.equal(snapshot.discardedEvents, 0)
      const { actors, revision } = snapshot.missions[0]
      assert.equal(actors.length, targets + (action === "cleanup" ? 1 : 0))
      assert.ok(revision > 2_000, "the qualified range reads long histories")

      let beforeWrites = 0, nativeCalls = 0
      const published = new Error("Test ends immediately after intent publication")
      const nativeEffect = async () => { nativeCalls++; throw new Error("Unexpected native effect") }
      const input = { missionID, expectedRevision: revision, requestID: `${action}-request` }
      const options = {
        journal,
        timestamp: () => revision + 1,
        changed: async () => { throw published },
        transport: { prompt: nativeEffect, synthetic: nativeEffect, lifecycle: nativeEffect, cleanup: nativeEffect },
      }
      const before = async () => { beforeWrites++ }
      const run = action === "stop" ? controlMission({ ...input, action }, { ...options, beforeIntent: before })
        : deleteMission({ ...input, deleteManagedSessions: true }, { ...options, beforeDelete: before,
          sessions: { get: nativeEffect, create: nativeEffect, prompt: nativeEffect, synthetic: nativeEffect } })

      if (targets === 2_001) {
        await assert.rejects(run, /not durable owned JSON/)
        assert.deepEqual([beforeWrites, intents.length, nativeCalls], [0, 0, 0])
      } else {
        await assert.rejects(run, error => error === published)
        assert.deepEqual([beforeWrites, intents.length, nativeCalls], [1, 1, 0])
        const intent = intents[0]
        assert.equal(intent.type, action === "stop" ? "mission.control-requested" : "mission.deleted")
        assert.equal(intent.type === "mission.control-requested" ? intent.targets.length
          : intent.type === "mission.deleted" ? intent.cleanupTargets?.length : undefined, 2_000)
      }
    })
  }
}
