import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl, MissionControlError } from "../../missions/control"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { automaticMissionStartID } from "../../missions/preparation-result"
import { controlResumeAdmissionID, stableToken } from "../../missions/receipt-identity"
import { resolveMissionCreationDefaults } from "../../missions/profile-defaults"
import { prepareCoordinatorMission } from "./mission-prepare"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { MissionJsonValue } from "../../missions/model"
import type { NativeMissionSession } from "../../missions/control-types"
import type { MissionDocument } from "../../missions/mission-document"
import { MISSION_RPC_REJECTION } from "../../missions/rpc-errors"

const directory = "C:/isolated-mission-preparation", author = "ses_author"
const request = { requestID: "prepare_test", objective: "Private test", template: "custom" as const }
const creationRequestID = `prepare_${stableToken(`outside-mission\0${author}\0${request.requestID}`, 24)}`
type Cut = "create-ack" | "before-consume" | "consume-ack" | "before-play" | "admission-ack" | "play-ack" | "journal"

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const sessions = new Map<string, NativeMissionSession>([[author, { id: author, projectID: "project", location: { directory } }]])
  let cut: Cut | undefined, creates = 0, admissions = 0, starts = 0, capability = true, duplicateWorkspace = false, beforeStart: (() => Promise<void>) | undefined
  let prepareBackend!: NonNullable<import("../../missions/control-types").MissionInputTransport["prepare"]>
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    set: async (key: string, value: MissionJsonValue) => {
      if (cut === "journal" && value && typeof value === "object" && "type" in value && value.type === "mission.created") throw new Error("Cut")
      values.set(key, structuredClone(value))
    },
    scan: async ({ prefix }: { prefix: string }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: structuredClone(value) })) }),
    compareAndSet: async (key: string, value: MissionJsonValue, expected: number | null, current: () => true) => {
      current()
      const doc = value as unknown as MissionDocument
      if (cut === "before-play" && doc.oneTime?.firstPlay) throw new Error("Cut")
      assert.equal((values.get(key) as { revision?: number } | undefined)?.revision ?? null, expected)
      values.set(key, structuredClone(value))
      if (cut === "consume-ack" && doc.creation?.automaticStart?.attempted) throw new Error("Cut")
    },
  }
  const store = new NativeMissionDocumentStore(storage, "project", directory)
  const access = <T>(use: (store: NativeMissionDocumentStore) => Promise<T>) => use(store)
  const control = new MissionControl({ project: { id: "project", canonical: directory, location: { directory } },
    storage, documents: access, documentReads: access,
    sessions: {
      get: async ({ sessionID }) => { const session = sessions.get(sessionID); assert.ok(session); return session },
      create: async input => { creates++; const session = { ...input, projectID: "project" }; sessions.set(session.id, session); return session },
      prompt: async () => assert.fail("Only lifecycle admission may start"),
      synthetic: async () => assert.fail("Only lifecycle admission may start"),
    },
    transport: {
      prepare: (id, input) => prepareBackend(id, input),
      resolveCreationDefaults: async (_id, input) => resolveMissionCreationDefaults({ ...input, preferences: undefined }),
      prompt: async () => assert.fail("No direct prompt"),
      synthetic: async () => assert.fail("No direct synthetic input"),
      lifecycle: async (_id, input) => {
        admissions++
        const acknowledgement = { ...input, action: "start", disposition: "start-admitted",
          admission: { id: controlResumeAdmissionID(input.operationID, input.sessionID), sessionID: input.sessionID,
            type: "synthetic", delivery: "queue", time: { created: Date.now() }, payload: { text: request.objective,
              metadata: { "codenomad.mission": { version: 1, kind: "lifecycle", missionID: input.missionID, operationID: input.operationID } } } } }
        if (cut === "admission-ack") throw new Error("Cut")
        return { nativeAcknowledgement: acknowledgement }
      },
    },
  })
  const rpc = {
    snapshot: () => control.snapshot(),
    documentCapabilities: async () => ({ version: 1, ...(capability ? { automaticStart: true } : {}) }),
    create: async (input: Parameters<MissionControl["create"]>[0]) => {
      try {
        const result = await control.create(input)
        if (cut === "create-ack") throw new Error("Cut")
        return result
      } catch (error) {
        if (error instanceof MissionControlError) throw Object.assign(new Error(error.message), { type: MISSION_RPC_REJECTION,
          data: { code: error.code, ...("noEffect" in error ? { noEffect: error.noEffect } : {}) } })
        throw error
      }
    },
    lifecycle: async (input: Parameters<MissionControl["lifecycle"]>[0] & { automaticStart?: Parameters<MissionControl["lifecycle"]>[1] }) => {
      starts++
      await beforeStart?.()
      if (cut === "before-consume") throw new Error("Cut")
      const { automaticStart, ...lifecycle } = input
      try {
        const result = await control.lifecycle(lifecycle, automaticStart)
        if (cut === "play-ack") throw new Error("Cut")
        return result
      } catch (error) {
        if (error instanceof MissionControlError) throw Object.assign(new Error(error.message), { type: MISSION_RPC_REJECTION, data: { code: error.code } })
        throw error
      }
    },
  }
  const client = {
    session: { get: async ({ sessionID }: { sessionID: string }) => { const session = sessions.get(sessionID); assert.ok(session); return session } },
    location: { get: async () => ({ directory, project: { id: "project" } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => rpc,
  }
  const workspace = { id: "workspace" }, connection = { client, assertCurrent() {} }
  const manager = {
    get: () => workspace, list: () => duplicateWorkspace ? [workspace, { id: "second-tab" }] : [workspace], getServiceLocation: () => ({ directory }),
    getSharedServiceConnection: async () => connection, ownsLocation: async () => true,
    getServiceDirectoryForPath: async () => directory, getWorktreeIdentityForPath: async () => directory,
  }
  let fence = new WorktreeDeletionFence()
  prepareBackend = (id, input) => prepareCoordinatorMission(manager as never, fence, id, { kind: "prepare", input }, new AbortController().signal)
  const prepare = async (input = request as typeof request & { startOnCreation?: boolean }) => (await control.prepare(author, input)).preparation
  return { prepare, control, store, values, rpc, sessions, get creates() { return creates }, get admissions() { return admissions },
    get starts() { return starts }, setCut: (value?: Cut) => { cut = value }, oldNative: () => { capability = false },
    restartBackend: () => { fence = new WorktreeDeletionFence() },
    duplicateWorkspace: () => { duplicateWorkspace = true },
    beforeStart: (callback: () => Promise<void>) => { beforeStart = callback } }
}

for (const flag of [undefined, false, true]) test(`explicit creation start ${flag}: lifecycle only, once across retry`, async () => {
  const f = fixture(), input = { ...request, ...(flag === undefined ? {} : { startOnCreation: flag }) }
  const first = await f.prepare(input)
  assert.equal(first.outcome, flag ? "activated" : "prepared")
  assert.equal(f.admissions, flag ? 1 : 0)
  assert.equal(f.starts, flag ? 1 : 0)
  const replay = await f.prepare(input)
  assert.equal(replay.outcome, first.outcome)
  assert.ok("acknowledgement" in replay)
  assert.equal(replay.acknowledgement, "recovered")
  assert.equal(f.creates, 1)
  assert.equal(f.admissions, flag ? 1 : 0)
})

test("two project tabs with the same owned connection share one preparation owner", async () => {
  const f = fixture()
  f.duplicateWorkspace()
  assert.equal((await f.prepare({ ...request, startOnCreation: true })).outcome, "activated")
  assert.equal(f.creates, 1)
  assert.equal(f.admissions, 1)
})

for (const kind of ["descendant", "coordinator", "actor", "ended-actor", "daily", "scheduled", "passage-descendant"] as const)
  test(`${kind} authors create separately with explicit automatic first Play and replay without effects`, async () => {
    const f = fixture()
    const root = "ses_native_parent"
    if (kind === "coordinator") await f.control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: author })
    const original = f.sessions.get(author)!
    if (["descendant", "passage-descendant"].includes(kind)) {
      f.sessions.set(root, { ...original, id: root, ...(kind === "passage-descendant"
        ? { metadata: { "codenomad.mission": { missionID: "msn_source", kind: "coordinator",
          document: { missionID: "schedule", passageID: "passage" } } } } : {}) })
      original.parentID = root
    } else if (kind !== "coordinator") {
      original.metadata = { "codenomad.mission": { missionID: "msn_source", kind: kind.includes("actor") ? "task" : "coordinator",
        ...(kind === "daily" ? { recurrence: { scheduleID: "schedule", passageID: "passage" } } : {}),
        ...(kind === "scheduled" ? { document: { missionID: "schedule", passageID: "passage" } } : {}) } }
    }
    const before = structuredClone([...f.sessions]), source = (await f.control.snapshot()).missions
    const input = { ...request, startOnCreation: true }
    const first = await f.prepare(input)
    assert.equal(first.outcome, "activated")
    assert.ok(first.target?.kind === "one-time")
    const mission = first.target.mission
    assert.equal(mission.preparedBy!.coordinatorSessionId, author)
    assert.equal(mission.preparedBy!.missionId, kind === "descendant" ? undefined : kind === "coordinator" ? source[0].id : "msn_source")
    assert.notEqual(mission.coordinatorSessionId, author)
    assert.deepEqual([...f.sessions].slice(0, before.length), before)
    assert.deepEqual((await f.control.snapshot()).missions.filter(value => value.id !== mission.id), source)
    assert.equal((await f.control.inspect(author, { missionID: mission.id }, "read")).actor, null)
    assert.ok((await f.control.listMissions(author)).some(value => value.missionID === mission.id && value.relation === "prepared"))
    const bytes = structuredClone([...f.values])
    const replay = await f.prepare(input)
    assert.equal(replay.outcome, "activated")
    assert.ok(replay.target?.kind === "one-time")
    assert.equal(replay.target.mission.id, mission.id)
    assert.deepEqual([...f.values], bytes)
    assert.equal(f.creates, 1)
    assert.equal(f.admissions, 1)
    assert.equal(f.starts, 1)
  })

test("two concurrent positive requests consume a single automatic-start slot", async () => {
  const f = fixture(), input = { ...request, startOnCreation: true }
  const results = await Promise.all([f.prepare(input), f.prepare(input)])
  assert.equal(results.filter(result => result.outcome === "activated" && result.acknowledgement === "fresh").length, 1)
  assert.equal(f.admissions, 1)
  assert.equal(f.starts, 1)
  const mission = (await f.control.snapshot()).missions[0]
  const doc = await f.store.read(mission.id)
  assert.ok(doc && !("deletedAt" in doc))
  assert.deepEqual(doc.creation?.automaticStart, { requestID: automaticMissionStartID(creationRequestID), attempted: true })
  assert.deepEqual(doc.creation?.author, { coordinatorSessionID: author })
  assert.equal(doc.creation?.input?.startOnCreation, true)
  assert.ok(doc.creation?.creationDefaults)
  await assert.rejects(f.store.change(doc.id, doc.revision, () => true, next => { next.creation!.automaticStart!.attempted = false }), /immutable/)
})

test("concurrent lifecycle continuations cannot consume the same durable slot twice", async () => {
  const f = fixture()
  const creation = await f.control.create({ ...request, prepared: true, startOnCreation: true,
    preparedBy: { coordinatorSessionID: author }, expectedCoordinatorLocation: { directory } })
  assert.equal(creation.acknowledgement, "fresh")
  const input = { missionID: creation.mission.id, action: "start" as const, expectedRevision: creation.mission.revision,
    requestID: automaticMissionStartID(request.requestID), automaticStart: { creationRequestID: request.requestID,
      authorSessionID: author, expectedDocumentRevision: creation.mission.document!.revision } }
  const results = await Promise.allSettled([f.rpc.lifecycle(input), f.rpc.lifecycle(input)])
  assert.deepEqual(results.map(result => result.status).sort(), ["fulfilled", "rejected"])
  assert.equal(f.admissions, 1)
})

for (const cut of ["before-consume", "consume-ack", "before-play", "admission-ack", "play-ack"] as const)
  test(`cut at ${cut} preserves original identities without another Play`, async () => {
    const f = fixture(), input = { ...request, startOnCreation: true }
    f.setCut(cut)
    const first = await f.prepare(input)
    assert.equal(first.outcome, "uncertain")
    assert.ok(first.outcome === "uncertain")
    assert.equal(first.phase, "start")
    assert.equal(first.requestID, automaticMissionStartID(creationRequestID))
    f.setCut()
    const before = structuredClone([...f.values])
    const replay = await f.prepare(input)
    assert.equal(replay.outcome, cut === "play-ack" ? "activated" : cut === "before-consume" ? "prepared" : "uncertain")
    assert.deepEqual([...f.values], before, "recovery is read-only")
    assert.equal(f.starts, 1)
    assert.equal(f.admissions, ["admission-ack", "play-ack"].includes(cut) ? 1 : 0)
  })

for (const cut of ["create-ack", "journal"] as const) test(`recovered ${cut} creation cannot continue Play`, async () => {
  const f = fixture(), input = { ...request, startOnCreation: true }
  f.setCut(cut)
  await assert.rejects(f.prepare(input), /uncertain/)
  f.setCut()
  f.restartBackend()
  const replay = await f.prepare(input)
  assert.equal(replay.outcome, "prepared")
  assert.equal(f.starts, 0)
  assert.equal(f.admissions, 0)
  assert.equal(f.creates, 1)
})

test("changed automatic-start flag conflicts; an older native capability refuses before creation", async () => {
  const f = fixture()
  await f.prepare({ ...request, startOnCreation: false })
  await assert.rejects(f.prepare({ ...request, startOnCreation: true }), /different mission/)
  assert.equal(f.creates, 1)
  const old = fixture()
  old.oldNative()
  await assert.rejects(old.prepare({ ...request, startOnCreation: true }), (error: any) => error.code === "prepare-refused")
  assert.equal(old.creates, 0)
  assert.equal([...old.values.keys()].some(key => key.startsWith("codenomad-missions/documents")), false)
})

test("a human Pause racing first Play wins the exact journal/document revisions", async () => {
  const f = fixture()
  f.beforeStart(async () => {
    const mission = (await f.control.snapshot()).missions[0]
    await f.control.lifecycle({ missionID: mission.id, requestID: "human-pause", expectedRevision: mission.revision,
      action: "pause", graceful: true })
  })
  const result = await f.prepare({ ...request, startOnCreation: true })
  assert.equal(result.outcome, "refused")
  assert.ok(result.target)
  assert.equal(f.admissions, 0)
  assert.equal((await f.control.snapshot()).missions[0].runState, "paused")
})

test("a human Play racing automatic first Play admits only the human operation", async () => {
  const f = fixture()
  f.beforeStart(async () => {
    const mission = (await f.control.snapshot()).missions[0]
    await f.control.lifecycle({ missionID: mission.id, requestID: "human-play", expectedRevision: mission.revision, action: "start" })
  })
  const result = await f.prepare({ ...request, startOnCreation: true })
  assert.equal(result.outcome, "refused")
  assert.equal(f.admissions, 1)
  assert.equal((await f.control.snapshot()).missions[0].document!.firstPlay!.requestID, "human-play")
})
