import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl, MissionControlError } from "./control"
import type { MissionDeleteInput, MissionSessionAdapter, NativeMissionSession } from "./control-types"
import { MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"
import { MISSION_MAX_EVENTS, type MissionJsonValue, type MissionMap } from "./model"

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  let failReceipt = false
  const storage: MissionStorage = {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      if (failReceipt && parseMissionEvent(value)?.type === "mission.session-cleaned") {
        failReceipt = false
        throw new Error("Receipt write unavailable")
      }
      values.set(key, structuredClone(value))
    },
    scan: async ({ prefix, after, limit = 100 }) => {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value }))
      return { entries, next: entries.length === limit ? entries.at(-1)?.key : undefined }
    },
  }
  const native = new Map<string, NativeMissionSession>()
  const removed: string[] = []
  const failing = new Set<string>()
  const unreadable = new Set<string>()
  const children = new Set<string>()
  let active = true
  let now = 1_000
  const sessions: MissionSessionAdapter = {
    get: async ({ sessionID }) => {
      if (unreadable.has(sessionID)) throw new Error("Session lookup unavailable")
      const session = native.get(sessionID)
      if (!session) throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError", sessionID })
      return structuredClone(session)
    },
    create: async (input) => {
      assert.equal(native.has(input.id), false)
      const session = { ...input, projectID: "project-1" }
      native.set(input.id, session)
      return structuredClone(session)
    },
    list: async ({ parentID }) => ({ data: children.has(parentID) ? [{ id: "ses_child" }] : [] }),
    remove: async ({ sessionID }) => {
      if (failing.has(sessionID)) throw new Error("Native removal unavailable")
      assert.ok(native.has(sessionID))
      removed.push(sessionID)
      native.delete(sessionID)
    },
    prompt: async () => {},
    synthetic: async () => {},
  }
  const project = { id: "project-1", canonical: "/repo", location: { directory: "/repo" } }
  const control = () => new MissionControl({ project, storage, sessions, now: () => now++, isActive: () => active })
  const create = async (requestID = "create") => (await control().create({ requestID, objective: "Cleanup fixture", template: "custom" })).mission
  const delegate = async (mission: MissionMap, taskKey: string, targetSessionID?: string) => (await control().delegate(mission.coordinatorSessionId, {
    missionID: mission.id, taskKey, title: taskKey, brief: "Bounded fixture", role: "specialist", blockedBy: [], delivery: "queue", targetSessionID,
  })).mission
  const deletion = (mission: MissionMap, deleteManagedSessions?: boolean): MissionDeleteInput => ({
    missionID: mission.id, requestID: "delete-fixture", expectedRevision: mission.revision,
    ...(deleteManagedSessions === undefined ? {} : { deleteManagedSessions }),
  })
  return { values, storage, native, sessions, removed, failing, unreadable, children, control, create, delegate, deletion,
    journal: new MissionJournal(storage, project.id, project.canonical),
    failReceipt: () => { failReceipt = true }, deactivate: () => { active = false },
  }
}

const specialist = (mission: MissionMap) => mission.actors.find((actor) => actor.kind === "specialist")!.sessionId
const code = (expected: string) => (error: unknown) => error instanceof MissionControlError && error.code === expected

test("bridge cleanup authority is limited to pending tombstone targets and expires with receipts", async () => {
  const f = fixture()
  const mission = await f.delegate(await f.create(), "worker")
  const sessionID = specialist(mission)
  const request = f.deletion(mission, true)
  f.failing.add(sessionID)
  await assert.rejects(f.control().delete(request), code("cleanup-pending"))
  const deletion = (await f.journal.events()).events.find(event => event.type === "mission.deleted")!
  const input = { missionID: mission.id, deletionID: deletion.id, sessionID }
  assert.deepEqual((await f.control().cleanupTarget(input)).target, {
    sessionID, coordinatorSessionID: mission.coordinatorSessionId, projectID: mission.projectID,
    missionID: mission.id, location: { directory: "/repo" },
  })
  for (const invalid of [{ ...input, sessionID: mission.coordinatorSessionId }, { ...input, deletionID: "evt_other" }, { ...input, missionID: "msn_other" }]) {
    assert.deepEqual(await f.control().cleanupTarget(invalid), {})
  }
  f.failing.clear()
  await f.control().delete(request)
  assert.deepEqual(await f.control().cleanupTarget(input), {})
})

test("deletion is opt-in, preserving created coordinators and every conversation by default", async () => {
  for (const option of [undefined, false]) {
    const f = fixture()
    const mission = await f.delegate(await f.create(), "created-worker")
    const request = f.deletion(mission, option)
    assert.deepEqual(await f.control().delete(request), { deleted: true })
    assert.deepEqual(await f.control().delete({ ...request, deleteManagedSessions: false }), { deleted: true })
    assert.equal(f.native.size, 2)
    assert.deepEqual(f.removed, [])
    await assert.rejects(f.control().delete({ ...request, deleteManagedSessions: true }), code("request-conflict"))
  }
})

test("opt-in removes only created specialists, preserving coordinator and reused roots", async () => {
  const f = fixture()
  let mission = await f.delegate(await f.create(), "created-worker")
  const managed = specialist(mission)
  f.native.set("ses_reused", { id: "ses_reused", projectID: "project-1", location: { directory: "/repo" } })
  mission = await f.delegate(mission, "reused-worker", "ses_reused")
  const request = f.deletion(mission, true)
  await f.control().delete(request)
  assert.deepEqual(f.removed, [managed])
  assert.deepEqual([...f.native.keys()].sort(), [mission.coordinatorSessionId, "ses_reused"].sort())
  // A durable receipt must fence later reuse/recreation of an already handled ID.
  f.native.set(managed, { id: managed, projectID: "project-1", location: { directory: "/repo" } })
  await f.control().delete(request)
  assert.deepEqual(f.removed, [managed])
  assert.ok(f.native.has(managed))
  assert.deepEqual((await f.control().snapshot()).missions, [])
})

test("CAS and serialized concurrent deletion reject stale/different requests before cleanup", async () => {
  const f = fixture()
  const mission = await f.delegate(await f.create(), "worker")
  const request = f.deletion(mission, true)
  await assert.rejects(f.control().delete({ ...request, expectedRevision: 1 }), code("revision-conflict"))
  assert.equal(f.removed.length, 0)
  const results = await Promise.allSettled([
    f.control().delete(request), f.control().delete(request),
    f.control().delete({ ...request, deleteManagedSessions: false }),
  ])
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "rejected"])
  assert.equal(f.removed.length, 1)
  await assert.rejects(f.control().delete({ ...request, expectedRevision: 1 }), code("request-conflict"))
  await assert.rejects(f.control().delete({ ...request, requestID: "different" }), code("mission-not-found"))
})

test("partial native failure preserves immutable targets and retries after a new control instance", async () => {
  const f = fixture()
  let mission = await f.delegate(await f.create(), "first-worker")
  const first = specialist(mission)
  mission = await f.delegate(mission, "second-worker")
  const second = mission.tasks.find((task) => task.key === "second-worker")!.actorSessionId!
  f.failing.add(first)
  const request = f.deletion(mission, true)
  await assert.rejects(f.control().delete(request), code("cleanup-pending"))
  assert.deepEqual(f.removed, [second], "independent cleanup continues after one failure")
  assert.deepEqual((await f.control().snapshot()).missions, [])
  const tombstone = (await f.journal.events()).events.find((event) => event.type === "mission.deleted")!
  assert.equal(tombstone.type, "mission.deleted")
  if (tombstone.type === "mission.deleted") assert.equal(tombstone.cleanupTargets?.length, 2)
  f.failing.clear()
  await f.control().delete(request)
  await f.control().delete(request)
  assert.deepEqual(f.removed, [second, first])
})

test("a lost receipt retries via native not-found without repeating removal", async () => {
  const f = fixture()
  const mission = await f.delegate(await f.create(), "worker")
  const request = f.deletion(mission, true)
  f.failReceipt()
  await assert.rejects(f.control().delete(request), code("cleanup-pending"))
  await f.control().delete(request)
  assert.deepEqual(f.removed, [specialist(mission)])
})

test("lookup failures remain pending instead of being mistaken for native not-found", async () => {
  const f = fixture()
  const mission = await f.delegate(await f.create(), "worker")
  const id = specialist(mission)
  f.unreadable.add(id)
  const request = f.deletion(mission, true)
  await assert.rejects(f.control().delete(request), code("cleanup-pending"))
  assert.equal(f.removed.length, 0)
  f.unreadable.clear()
  await f.control().delete(request)
  assert.deepEqual(f.removed, [id])
})

test("shared actors are preserved across active, completed and deleted other missions", async () => {
  for (const otherStatus of ["active", "completed", "deleted"] as const) {
    for (const membership of ["coordinator", "specialist"] as const) {
      const f = fixture()
      const original = await f.delegate(await f.create(), "worker")
      const id = specialist(original)
      await f.control().report(original.coordinatorSessionId, { missionID: original.id, outcome: "failed", summary: "Done", evidence: [], next: [], final: true })
      let other = membership === "coordinator"
        ? (await f.control().create({ requestID: "other", objective: "Other", template: "custom", coordinatorSessionID: id })).mission
        : await f.delegate(await f.create("other"), "reuse-worker", id)
      if (otherStatus === "completed") {
        if (membership === "specialist") await f.control().report(id, { missionID: other.id, taskKey: "reuse-worker", outcome: "completed", summary: "Done", evidence: [], next: [], final: false })
        other = (await f.control().report(other.coordinatorSessionId, { missionID: other.id, outcome: "completed", summary: "Done", evidence: [], next: [], final: true })).mission
      } else if (otherStatus === "deleted") await f.control().delete(f.deletion(other))
      const current = (await f.control().snapshot()).missions.find((mission) => mission.id === original.id)!
      await f.control().delete(f.deletion(current, true))
      assert.ok(f.native.has(id), `${membership} in ${otherStatus} mission must survive`)
      assert.deepEqual(f.removed, [])
    }
  }
})

test("cleanup fails closed for native identity/location/metadata changes and recursive descendants", async () => {
  const mutations: Array<(session: NativeMissionSession) => void> = [
    (s) => { s.id = "ses_different" },
    (s) => { s.projectID = "foreign-project" },
    (s) => { s.parentID = "ses_parent" },
    (s) => { s.location.directory = "/foreign" },
    (s) => { s.location.workspaceID = "foreign-workspace" },
    (s) => { s.metadata = undefined },
    (s) => { s.metadata = { "codenomad.mission": { version: 1, kind: "actor", missionID: "foreign" } } },
    (s) => { s.metadata = { "codenomad.mission": { version: 1, kind: "coordinator", missionID: "foreign" } } },
  ]
  for (const mutate of mutations) {
    const f = fixture()
    const mission = await f.delegate(await f.create(), "worker")
    const id = specialist(mission)
    mutate(f.native.get(id)!)
    await f.control().delete(f.deletion(mission, true))
    assert.ok(f.native.has(id))
    assert.deepEqual(f.removed, [])
  }
  const f = fixture()
  const mission = await f.delegate(await f.create(), "worker")
  f.children.add(specialist(mission))
  await f.control().delete(f.deletion(mission, true))
  assert.deepEqual(f.removed, [])
})

test("revalidates ownership and lifecycle after native child lookup before removal", async () => {
  for (const change of ["move", "dispose"] as const) {
    const f = fixture()
    const mission = await f.delegate(await f.create(), "worker")
    f.sessions.list = async () => {
      if (change === "move") f.native.get(specialist(mission))!.location.directory = "/foreign"
      else f.deactivate()
      return { data: [] }
    }
    const result = f.control().delete(f.deletion(mission, true))
    if (change === "dispose") await assert.rejects(result, code("cleanup-pending"))
    else await result
    assert.deepEqual(f.removed, [])
  }
})

test("missing optional native APIs remain compatible with default deletion and pending with opt-in", async () => {
  const f = fixture()
  const mission = await f.delegate(await f.create(), "worker")
  f.sessions.remove = undefined
  const request = f.deletion(mission, true)
  await assert.rejects(f.control().delete(request), code("cleanup-pending"))
  assert.equal(f.native.size, 2)
})

test("legacy tombstones parse, malformed destructive intent is rejected", () => {
  const legacy = { version: 1, type: "mission.deleted", id: "evt_delete", missionID: "msn_fixture", projectID: "project-1", createdAt: 1, requestID: "delete", expectedRevision: 1 }
  assert.ok(parseMissionEvent(legacy))
  assert.equal(parseMissionEvent({ ...legacy, deleteManagedSessions: "true" }), undefined)
  assert.equal(parseMissionEvent({ ...legacy, deleteManagedSessions: true }), undefined)
  assert.equal(parseMissionEvent({ ...legacy, deleteManagedSessions: false, cleanupTargets: [] }), undefined)
  assert.ok(parseMissionEvent({ ...legacy, deleteManagedSessions: true, cleanupTargets: [] }))
})

test("pending cleanup reserves its journal receipts against unrelated writes at the event limit", async () => {
  const f = fixture()
  const mission = await f.delegate(await f.create(), "worker")
  const id = specialist(mission)
  for (let index = f.values.size; index < MISSION_MAX_EVENTS - 2; index++) {
    const event = { version: 1, id: `evt_fill_${index}`, type: "task.dispatched", missionID: "msn_fill", projectID: "project-1", taskKey: "unused", createdAt: 1 }
    f.values.set(`codenomad-missions/v1/${f.journal.projectToken}/msn_fill/${event.id}`, event)
  }
  f.failing.add(id)
  const request = f.deletion(mission, true)
  await assert.rejects(f.control().delete(request), code("cleanup-pending"))
  assert.equal(f.values.size, MISSION_MAX_EVENTS - 1)
  await assert.rejects(f.journal.append({ version: 1, id: "evt_unrelated", type: "task.dispatched", missionID: "msn_fill", projectID: "project-1", taskKey: "unused", createdAt: 1 }), /safety limit/)
  f.failing.clear()
  await f.control().delete(request)
  assert.equal(f.values.size, MISSION_MAX_EVENTS)
  await f.control().delete(request)
  assert.deepEqual(f.removed, [id])
})

test("retry rechecks new shared membership before touching a formerly eligible target", async () => {
  const f = fixture()
  const mission = await f.delegate(await f.create(), "worker")
  const id = specialist(mission)
  f.failing.add(id)
  const request = f.deletion(mission, true)
  await assert.rejects(f.control().delete(request), code("cleanup-pending"))
  await f.delegate(await f.create("later-mission"), "reused-worker", id)
  f.failing.clear()
  await f.control().delete(request)
  assert.ok(f.native.has(id))
  assert.deepEqual(f.removed, [])
})
