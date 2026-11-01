import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Schema } from "effect"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import type { MissionConfiguration } from "../../missions/launch-policy"
import type { MissionStorage } from "../../missions/journal"
import type { MissionJsonValue } from "../../missions/model"
import type { NativeMissionSession } from "../../missions/control-types"
import type { MissionDocument } from "../../missions/mission-document"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { documentPassageStartInput, documentWatchCheckpoint, documentWatchCheckpointSchema } from "../../missions/mission-document-passage-input"
import { admitNativeScheduledPassage } from "./native-scheduled-passage-admission"
import { nativeScheduledPassageBusiness, type NativeScheduledPassageContext } from "./native-scheduled-passage-business"
import { observeNativeScheduledPassage } from "./native-scheduled-passage-settlement"
import { documentManualPassageAllowed, documentPassageDispatchAllowed } from "./native-scheduled-passage-authority"
import { prepareNativeDocumentSources } from "./native-scheduled-passage-sources"
import { createNativeScheduledPassageBusinessPort, type NativeScheduledPassageRuntime } from "./native-scheduled-passage-runtime"
import type { MissionNativeService } from "./native-service-adapter"
import type { PassageSessionObservation } from "./native-passage-observation"
import { controlNativeScheduledPassage } from "./native-scheduled-passage-controls"
import { controlResumeAdmissionID } from "../../missions/receipt-identity"

const current = () => true as const, at = Date.parse("2026-10-01T00:00:00Z")
async function fixture() {
  const values = new Map<string, MissionJsonValue>(), sessions = new Map<string, NativeMissionSession>()
  const messages = new Map<string, typeof SessionMessage.Info.Type>(), states = new Map<string, PassageSessionObservation>()
  let sends = 0, creates = 0, environments = 0, crash = false, requests = false, crashCreate = false, crashAttemptWrite = false
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value, guard) => { guard?.(); values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const all = [...values].filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      const entries = all.slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries, ...(all.length > limit ? { next: entries.at(-1)!.key } : {}) }
    },
  }
  const conditional: MissionDocumentStorage = { get: storage.get, compareAndSet: async (key, value, revision, guard) => {
    guard(); assert.equal((values.get(key) as { revision: number } | undefined)?.revision ?? null, revision)
    values.set(key, structuredClone(value))
    if (crashAttemptWrite && (value as unknown as MissionDocument).pending?.admissionAttempted) {
      crashAttemptWrite = false
      throw new Error("lost attempt publication ACK")
    }
  } }
  const store = new NativeMissionDocumentStore(conditional, "project", "/project")
  const selection = { agent: "worker", model: { providerID: "unit", id: "model" } }
  const config: MissionConfiguration = { title: "Passage", objective: "Do the requested bounded work", template: "custom", taskMode: "native",
    profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [],
    profiles: { coordinator: selection, roles: { specialist: selection } },
    launch: { timing: { kind: "immediate" }, condition: null, ends: { maxLaunches: null, at: null, afterMs: null } } }
  let doc = await store.create("review", config, at, current)
  doc = await store.change(doc.id, doc.revision, current, next => changes.play(next, "first_play", at, []))
  await store.change(doc.id, doc.revision, current, next => changes.reserve(next, { kind: "manual", requestID: "run_original" }, at, []))
  const native = {
    location: { directory: "/project", project: { id: "project", canonical: "/project", directory: "/project" } }, assertCurrent: current,
    get: async ({ sessionID }: { sessionID: string }) => { const session = sessions.get(sessionID); assert.ok(session); return structuredClone(session) },
    create: async (input: { id: string; agent: string; model: NativeMissionSession["model"]; metadata: NativeMissionSession["metadata"] }, _options: unknown, guard: () => true) => {
      guard(); creates++
      const session = { ...input, projectID: "project", location: { directory: "/project" } }
      sessions.set(input.id, session)
      states.set(input.id, { id: input.id, projectID: "project", directory: "/project", active: false, inbox: 0,
        suspended: false, runningTools: 0, failed: false, messagePresent: false })
      if (crashCreate) { crashCreate = false; throw new Error("lost root create ACK") }
      return session
    },
    inbox: async () => [],
    message: async ({ messageID }: { messageID: string }) => messages.get(messageID),
    environment: async (_input: unknown, _options: unknown, guard: () => true) => { guard(); environments++ },
    admit: async ({ input }: { input: ReturnType<typeof documentPassageStartInput> }, _options: unknown, guard: () => true) => {
      assert.equal((await store.read("review") as MissionDocument).pending!.admissionAttempted, true)
      guard(); sends++
      messages.set(input.id, Schema.decodeUnknownSync(SessionMessage.Info)({ type: "synthetic", id: input.id, text: input.text,
        description: input.description, metadata: input.metadata, time: { created: at } }))
      states.get(input.sessionID)!.terminal = { inputMessageID: input.id, messageID: "msg_terminal", outcome: "succeeded" }
      if (crash) { crash = false; throw new Error("lost native ACK") }
      return Schema.decodeUnknownSync(SessionInbox.Info)({ type: "synthetic", id: input.id, sessionID: input.sessionID,
        payload: { text: input.text, description: input.description, metadata: input.metadata }, delivery: input.delivery, time: { created: at } })
    },
  } as unknown as MissionNativeService
  const observation: NativeScheduledPassageContext["observation"] = {
    assertCurrent: current, exists: async id => sessions.has(id),
    session: async (id, messageID) => { const state = states.get(id); assert.ok(state)
      return { ...structuredClone(state), messagePresent: messages.has(messageID ?? state.terminal?.inputMessageID ?? "") } },
    children: async id => [...sessions.values()].filter(session => session.parentID === id).map(session => session.id),
    requests: async () => requests,
  }
  const read = async (): Promise<MissionDocument> => { const doc = await store.read("review"); assert.ok(doc && !("deletedAt" in doc)); return doc }
  const use = <T>(callback: (input: NativeScheduledPassageContext) => Promise<T>) => store.withExclusion(async locked => callback({
    document: await read(), locked, storage, native, observation, authority: () => locked.assertActive(),
    profile: { profileID: "profile", executionHost: "local", configYamlPath: "unused-isolated-profile" },
    signal: new AbortController().signal, current, now: () => at + 1000, environment: async () => ({ PASSAGE_UNIT: "fresh" }),
  }))
  const admit = async () => {
    const result = await use(admitNativeScheduledPassage)
    if (result.kind === "admitted") { const doc = await read(); await store.change(doc.id, doc.revision, current, next => changes.admitted(next, result.passageID, result.at)) }
    return result
  }
  return { values, storage, store, read, use, admit, native, sessions, messages, states, observation,
    counts: () => ({ sends, creates, environments }), set crash(value: boolean) { crash = value }, set requests(value: boolean) { requests = value },
    set crashCreate(value: boolean) { crashCreate = value }, set crashAttemptWrite(value: boolean) { crashAttemptWrite = value } }
}

test("lost original ACK reconciles exact message once, then pruning cannot resend or settle uncorrelated work", async () => {
  const f = await fixture(); f.crash = true
  const original = (await f.read()).pending!
  await assert.rejects(f.admit(), /lost native ACK/)
  assert.equal((await f.read()).launchedCount, 0)
  assert.equal((await f.read()).pending!.admissionAttempted, true)
  assert.equal((await f.admit()).kind, "admitted")
  assert.equal((await f.read()).launchedCount, 1)
  assert.equal((await f.admit()).kind, "recorded")
  assert.deepEqual(f.counts(), { sends: 1, creates: 1, environments: 1 })
  f.messages.delete(original.messageID)
  f.states.get(original.coordinatorSessionID)!.terminal = undefined
  assert.equal((await f.admit()).kind, "recorded")
  assert.equal(await f.use(observeNativeScheduledPassage), undefined)
  assert.equal(f.counts().sends, 1)
})

test("attempted original with lost ACK and pruned proof stays unknown without resend, ENV or root recreation", async () => {
  const f = await fixture(); f.crash = true
  const original = (await f.read()).pending!
  await assert.rejects(f.admit(), /lost native ACK/)
  f.messages.delete(original.messageID)
  f.states.get(original.coordinatorSessionID)!.terminal = undefined
  const counts = f.counts()
  assert.equal((await f.admit()).kind, "unknown")
  assert.deepEqual(f.counts(), counts)
  let doc = await f.read()
  assert.equal(doc.pending!.id, original.id); assert.equal(doc.pending!.admissionAttempted, true)
  assert.equal(doc.launchedCount, 0); assert.equal(doc.history.length, 0)
  await assert.rejects(f.store.change(doc.id, doc.revision, current, next => { next.pending!.admissionAttempted = false }), /monotone/)
  f.sessions.delete(original.coordinatorSessionID)
  assert.equal((await f.admit()).kind, "unknown")
  assert.deepEqual(f.counts(), counts)
  doc = await f.read()
  assert.equal(doc.pending!.id, original.id); assert.equal(doc.launchedCount, 0)
})

test("root creation crash before write-ahead attempt still permits exactly the first original admission", async () => {
  const f = await fixture(); f.crashCreate = true
  const original = (await f.read()).pending!
  await assert.rejects(f.admit(), /lost root create ACK/)
  assert.equal((await f.read()).pending!.admissionAttempted, false)
  assert.deepEqual(f.counts(), { creates: 1, sends: 0, environments: 0 })
  assert.equal((await f.admit()).kind, "admitted")
  const doc = await f.read()
  assert.equal(doc.pending!.id, original.id); assert.equal(doc.pending!.messageID, original.messageID)
  assert.equal(doc.pending!.admissionAttempted, true); assert.equal(doc.launchedCount, 1)
  assert.deepEqual(f.counts(), { creates: 1, sends: 1, environments: 1 })
})

test("lost attempt-write ACK before the native effect conservatively parks the same pending", async () => {
  const f = await fixture(); f.crashAttemptWrite = true
  const original = (await f.read()).pending!
  await assert.rejects(f.admit(), /lost attempt publication ACK/)
  assert.equal((await f.read()).pending!.admissionAttempted, true)
  assert.deepEqual(f.counts(), { creates: 1, sends: 0, environments: 1 })
  assert.equal((await f.admit()).kind, "unknown")
  assert.deepEqual(f.counts(), { creates: 1, sends: 0, environments: 1 })
  assert.equal((await f.read()).pending!.id, original.id)
  assert.equal((await f.read()).launchedCount, 0)
})

test("changed original message cannot qualify admission or increment the launch counter", async () => {
  const f = await fixture(); f.crash = true
  await assert.rejects(f.admit())
  const pending = (await f.read()).pending!, original = f.messages.get(pending.messageID)!
  assert.equal(original.type, "synthetic")
  f.messages.set(pending.messageID, { ...original, text: "foreign instructions" } as typeof original)
  await assert.rejects(f.admit(), /payload differs/)
  assert.equal((await f.read()).launchedCount, 0); assert.equal(f.counts().sends, 1)
})

test("business creation is isolated and task-created mark persists under DOCUMENT then MissionControl exclusion", async () => {
  const f = await fixture()
  await f.admit()
  await f.use(async input => {
    const scoped = nativeScheduledPassageBusiness(input), id = input.document.pending!.coordinatorSessionID
    await scoped.control.declare(id, { taskKey: "bounded_work", title: "Bounded work", brief: "Perform the bounded task", role: "specialist", blockedBy: [] })
    assert.equal((await input.locked.read(input.document.id) as MissionDocument).everCreatedTask, true)
    const map = await scoped.control.snapshot()
    assert.equal(map.missions[0].tasks.length, 1)
  })
  assert.ok([...f.values.keys()].every(key => key.startsWith("codenomad-missions/documents-v1/")))
  assert.equal((await f.read()).everCreatedTask, true)
})

test("H11 keeps old claims, pending requests and missing terminal correlation pending; completed report wins after quiet recheck", async () => {
  const f = await fixture(); await f.admit()
  const pending = (await f.read()).pending!, state = f.states.get(pending.coordinatorSessionID)!
  state.suspended = true
  assert.equal(await f.use(observeNativeScheduledPassage), undefined)
  state.suspended = false; f.requests = true
  assert.equal(await f.use(observeNativeScheduledPassage), undefined)
  f.requests = false
  await f.use(async input => { await nativeScheduledPassageBusiness(input).control.report(pending.coordinatorSessionID,
    { final: true, outcome: "completed", summary: "Useful work delivered", evidence: [], next: [] }) })
  state.failed = true
  assert.equal((await f.use(observeNativeScheduledPassage))?.outcome, "completed")
})

test("frozen input is reconstructed after observed-existing admission even when its KV write acknowledgement was lost", async () => {
  const f = await fixture(); f.crash = true
  await assert.rejects(f.admit())
  const doc = await f.read(), key = missionDocumentPassage(f.storage, doc, current).inputKey
  f.values.delete(key)
  assert.equal((await f.admit()).kind, "admitted")
  assert.ok(f.values.has(key)); assert.equal(f.counts().sends, 1)
})

test("Run now paused consent is durable on the original pending, revocable, and never admits after Stop", async () => {
  const f = await fixture(), doc = await f.read()
  const paused = await f.store.change(doc.id, doc.revision, current, next => { next.state = "paused"; next.pending!.manualAllowed = true })
  assert.equal(documentManualPassageAllowed(paused), true)
  assert.equal(documentPassageDispatchAllowed(paused), true)
  await f.admit()
  let latest = await f.read()
  latest = await f.store.change(latest.id, latest.revision, current, next => { next.pending!.manualAllowed = false })
  assert.equal(documentPassageDispatchAllowed(latest), false)
  latest = await f.store.change(latest.id, latest.revision, current, next => { next.state = "stopped"; next.pending!.manualAllowed = true })
  assert.equal(documentPassageDispatchAllowed(latest), false)
  assert.equal((await f.admit()).kind, "recorded"); assert.equal(f.counts().sends, 1)
})

test("configured conditions without a qualified external reader fail closed before any native source input", async () => {
  const f = await fixture(), doc = await f.read()
  doc.configuration.launch.condition = { kind: "files-changed", paths: ["src/app.ts"] }
  await assert.rejects(prepareNativeDocumentSources(doc, f.native, new AbortController().signal, current), /condition reader unavailable/)
  assert.equal(f.counts().sends, 0)
})

test("watched input freezes complete native prefixes and capacity references never advance the consumed anchor", async () => {
  const f = await fixture(), doc = await f.read()
  const source = { conversationID: "ses_watched", directory: "/project", afterMessageID: null,
    messages: [{ id: "msg_complete", type: "user", text: "Complete original message", nativeDigest: "a".repeat(64) }] }
  const checkpoint = documentWatchCheckpoint(source)
  doc.pending!.configuration.watchedConversationIDs = [source.conversationID]
  doc.pending!.checkpoints = [checkpoint]
  const original = documentPassageStartInput(doc)
  source.messages[0].text = "Newer unrelated source prose"
  doc.configuration.objective = "Future instructions"
  assert.deepEqual(documentPassageStartInput(doc), original)
  const overflow = documentWatchCheckpoint({ ...source, afterMessageID: "msg_complete", messages: [
    { id: "msg_overflow", type: "user", text: "", nativeDigest: "b".repeat(64), needsDecision: "source-input-capacity" },
  ] }, checkpoint)
  const anchor = documentWatchCheckpointSchema.parse(overflow.value)
  assert.equal(anchor.messageID, "msg_complete"); assert.equal(anchor.nativeDigest, "a".repeat(64))
  doc.pending!.configuration.roots = [{ mode: "directory-only", directory: "/foreign" }]
  assert.throws(() => documentPassageStartInput(doc), /source coverage unavailable/)
})

test("persistent business port acquires fresh invocation for each execute/prepare and accepts void tool results", async () => {
  let acquisitions = 0, active = false, executions = 0, preparations = 0
  const port = createNativeScheduledPassageBusinessPort(async use => {
    assert.equal(active, false); active = true; acquisitions++
    const runtime = {
      businessSelection: async () => ({ readSessionID: "ses_root" }),
      executeBusiness: async (_id: string, _entry: unknown, callback: (control: unknown) => Promise<unknown>) => {
        assert.equal(active, true); executions++; return { value: await callback({}) }
      },
      prepareBusiness: async () => { assert.equal(active, true); preparations++; return true },
    } as unknown as NativeScheduledPassageRuntime
    try { return await use(runtime, { current, signal: new AbortController().signal }) } finally { active = false }
  }, current, async id => ({ id, metadata: id === "ses_root" ? { "codenomad.mission": { document: {} } } : {} }))
  const route = await port.select("ses_root")
  assert.ok(route); assert.equal(active, false)
  assert.throws(() => route.control, /invocation-scoped execute/)
  await route.beforeTool("inspect", {})
  await route.execute!(async () => undefined)
  await route.execute!(async () => "result")
  await port.prepare("ses_root")
  assert.equal(await port.select("ses_ordinary"), undefined)
  assert.equal(await port.prepare("ses_ordinary"), false)
  assert.equal(acquisitions, 4); assert.equal(executions, 2); assert.equal(preparations, 1)
})

test("dedicated Pause/Resume reuses original journal control revision and native receipts without counting or resending the original", async () => {
  const f = await fixture(); await f.admit()
  let doc = await f.read(), calls = 0, partial = true
  doc = await f.store.change(doc.id, doc.revision, current, next => { next.state = "paused"; next.pending!.manualAllowed = false })
  const lifecycle = async (input: NativeScheduledPassageContext) => {
    input.lifecycle = async (_rootID, route) => {
      calls++
      if (partial) throw new Error("Native family coverage incomplete")
      const mission = (await nativeScheduledPassageBusiness(input).control.snapshot()).missions[0]
      const action = mission.control!.action
      if (action === "start") return { nativeAcknowledgement: { ...route, action, disposition: "start-admitted",
        admission: { id: controlResumeAdmissionID(route.operationID, route.sessionID), sessionID: route.sessionID, type: "synthetic", delivery: "queue",
          time: { created: at + 1000 }, payload: { text: "Resume the existing work", metadata: { "codenomad.mission": {
            version: 1, missionID: route.missionID, kind: "lifecycle", operationID: route.operationID } } } } } }
      return { nativeAcknowledgement: { ...route, action, disposition: "interrupt-observed", interrupt: { interrupted: true }, cancellations: [],
        descendants: { observed: 0, interrupted: 0, cancelled: 0, unconfirmed: 0, complete: true, sessions: [] } } }
    }
  }
  const pause = () => f.use(async input => { await lifecycle(input); return controlNativeScheduledPassage(input, { action: "pause", requestID: "human_pause" }) })
  assert.equal((await pause()).pending, true)
  const originalRevision = await f.use(async input => (await nativeScheduledPassageBusiness(input).control.snapshot()).missions[0].control!.expectedRevision)
  partial = false
  assert.equal((await pause()).pending, false)
  assert.equal((await pause()).pending, false); assert.equal(calls, 2)
  await f.use(async input => {
    const mission = (await nativeScheduledPassageBusiness(input).control.snapshot()).missions[0]
    assert.equal(mission.control!.expectedRevision, originalRevision); assert.equal(mission.control!.receipts!.length, 1)
  })
  doc = await f.read()
  await f.store.change(doc.id, doc.revision, current, next => { next.state = "running" })
  assert.equal((await f.use(async input => { await lifecycle(input); return controlNativeScheduledPassage(input, { action: "start", requestID: "human_resume" }) })).pending, false)
  assert.equal((await f.read()).launchedCount, 1); assert.equal(f.counts().sends, 1)
})

test("unadmitted control needs positive native family absence and never starts a new lifecycle input", async () => {
  const f = await fixture(), doc = await f.read()
  await f.store.change(doc.id, doc.revision, current, next => { next.state = "stopped" })
  assert.equal((await f.use(input => controlNativeScheduledPassage(input, { action: "stop", requestID: "human_stop" }))).pending, false)
  f.observation.exists = async () => true
  assert.equal((await f.use(input => controlNativeScheduledPassage(input, { action: "stop", requestID: "human_stop" }))).pending, true)
  assert.equal((await f.read()).launchedCount, 0); assert.equal(f.counts().sends, 0)
})
