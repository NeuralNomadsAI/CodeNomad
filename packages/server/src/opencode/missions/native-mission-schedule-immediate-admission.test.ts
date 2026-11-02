import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { Location } from "@opencode/schema/location"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { prepareNativeImmediateMissionControl } from "./native-mission-schedule-immediate"
import { nativeImmediatePlayPassage, nativeMissionScheduleResult } from "./native-mission-schedule-result"
import { MissionDocumentPassageEngine } from "../../missions/mission-document-passage-engine"
import type { MissionDocument } from "../../missions/mission-document"
import type { MissionStorage } from "../../missions/journal"
import type { NativeMissionSession } from "../../missions/control-types"
import type { MissionNativeService } from "./native-service-adapter"
import type { NativePassageObservation } from "./native-passage-observation"
import { admitNativeScheduledPassage } from "./native-scheduled-passage-admission"
import { documentPassageStartInput } from "../../missions/mission-document-passage-input"

for (const delta of [0, 1]) test(`immediate Play remains unknown until exact original proof, timestamp delta ${delta}ms and lost ACK`, { timeout: 10_000 }, async t => {
  const f = await ownerFixture(t)
  let doc = await f.control("configure", "convert_immediate", { ...f.configuration, launch: {
    timing: { kind: "immediate" }, condition: null, ends: { maxLaunches: null, afterMs: null, at: null } } })
  const request = { missionID: doc.id, requestID: "original_play", expectedRevision: doc.revision, action: "play" as const }
  const publications = await Promise.all([0, 1].map(() => prepareNativeImmediateMissionControl(f.store, request, f.current, () => f.now)))
  assert.deepEqual(publications[0], publications[1], "concurrent first Play publishes one original reservation")
  doc = publications[0]
  assert.equal(doc.pending!.createdAt, doc.calendarOwner!.operation.startedAt)
  if (delta) doc = await f.store.change(doc.id, doc.revision, f.current, value => {
    value.calendarOwner!.operation.startedAt += delta
    value.calendarOwner!.receipts.find(receipt => receipt.requestID === request.requestID)!.startedAt += delta
  })
  const originalID = doc.pending!.id, originalMessageID = doc.pending!.messageID, originalRootID = doc.pending!.coordinatorSessionID
  const roots = new Map<string, Session.Info>(), messages = new Map<string, typeof SessionMessage.Info.Type>()
  let blocked = true, loseAck = true, sends = 0
  let entered!: () => void, release!: () => void
  const admissionEntered = new Promise<void>(resolve => { entered = resolve })
  const acknowledge = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const storage: MissionStorage = {
    get: async key => structuredClone(f.values.get(key)), set: async (key, value, current) => { current?.(); f.values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const all = [...f.values].filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after)).sort(([a], [b]) => a.localeCompare(b))
      const entries = all.slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries, ...(all.length > limit ? { next: entries.at(-1)!.key } : {}) }
    },
  }
  const ctx = { ...f.ctx, storage: { ...f.ctx.storage, scan: (input: Parameters<MissionStorage["scan"]>[0]) => Effect.promise(() => storage.scan(input)) } }
  const native: MissionNativeService = {
    location: Schema.decodeUnknownSync(Location.Info)({ directory: f.directory,
      project: { id: "project", canonical: f.directory, directory: f.directory } }), assertCurrent: f.current,
    get: async ({ sessionID }) => {
      const root = roots.get(sessionID)!
      return { ...root, metadata: root.metadata as NativeMissionSession["metadata"] }
    },
    create: async (input, _options, current) => {
      current()
      const root = Schema.decodeUnknownSync(Session.Info)({ ...input, projectID: "project", cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: f.now, updated: f.now } })
      roots.set(root.id, root); return root
    },
    inbox: async () => [], message: async ({ messageID }) => messages.get(messageID),
    environment: async (_input, _options, current) => { current() }, cancelInbox: async () => {}, sourceMessages: async () => [],
    admit: async (command, _options, current) => {
      current()
      const input = command.input as ReturnType<typeof documentPassageStartInput>
      assert.equal((await f.read()).pending!.admissionAttempted, true)
      sends++
      messages.set(input.id, Schema.decodeUnknownSync(SessionMessage.Info)({ ...input, type: "synthetic", time: { created: f.now } }))
      if (loseAck) { loseAck = false; entered(); await acknowledge; throw new Error("native original admitted, ACK lost") }
      const receipt = Schema.decodeUnknownSync(SessionInbox.Info)({ id: input.id, sessionID: input.sessionID, type: "synthetic", delivery: "queue",
        payload: { text: input.text, description: input.description, metadata: input.metadata }, time: { created: f.now } })
      if (receipt.type !== "synthetic") throw new Error("Unexpected ACK type")
      return receipt
    },
  }
  const observation: NativePassageObservation = {
    assertCurrent: f.current, assertScheduleCurrent: f.current, exists: async id => roots.has(id), children: async () => [], requests: async () => false,
    session: async (id, messageID) => ({ id, projectID: "project", directory: f.directory, active: false, inbox: 0,
      suspended: false, runningTools: 0, failed: false, messagePresent: !!messageID && messages.has(messageID) }),
  }
  const engine = new MissionDocumentPassageEngine(f.store, {
    incarnation: "current", now: () => f.now, current: f.current,
    verifyWake: async () => { throw new Error("immediate has no native calendar") },
    coverage: async () => { throw new Error("immediate has no native calendar") },
    snapshot: async () => ({ changed: true, checkpoints: [], current: f.current }), observe: async () => undefined,
    admit: async (document, locked) => blocked ? { kind: "unknown" } : admitNativeScheduledPassage({ document, locked, storage, native,
      observation, authority: f.current, profile: document.calendarOwner!.profileSource, signal: new AbortController().signal,
      current: () => locked.assertActive(), now: () => f.now, environment: async () => ({}) }),
  })
  const status = async (requestID?: string) => nativeMissionScheduleResult(ctx, await f.read(), Effect.runPromise, false, requestID)
  assert.equal(await engine.reconcile({ missionID: doc.id }), "unknown")
  assert.equal((await status(request.requestID)).pending, true)
  assert.equal((await status(request.requestID)).document!.control!.pending, true)
  assert.equal((await status()).pending, true)
  assert.equal(roots.size, 0)
  for (let n = 0; n < 17; n++) {
    const fresh = await f.read()
    await prepareNativeImmediateMissionControl(f.store, { ...request, action: "check", requestID: `check_${n}`, expectedRevision: fresh.revision }, f.current, () => f.now)
  }
  assert.equal((await f.read()).calendarOwner!.receipts.length, 16)
  assert.equal((await status(request.requestID)).document!.control!.pending, true, "unknown original survives the bounded Check history")
  assert.equal((await status()).pending, true)
  blocked = false
  const first = engine.reconcile({ missionID: doc.id })
  await admissionEntered
  const concurrent = engine.reconcile({ missionID: doc.id })
  assert.equal((await f.read()).launchedCount, 0)
  assert.equal((await status(request.requestID)).pending, true)
  assert.equal(sends, 1)
  release()
  assert.deepEqual(await Promise.all([first, concurrent]), ["unknown", "pending"])
  const replay = await prepareNativeImmediateMissionControl(f.store, request, f.current, () => f.now)
  assert.equal(nativeImmediatePlayPassage(replay, request.requestID)!.id, originalID)
  assert.equal(await engine.reconcile({ missionID: doc.id }), "pending")
  assert.equal(await engine.reconcile({ missionID: doc.id }), "pending")
  const admitted = await f.read()
  assert.equal(admitted.launchedCount, 1); assert.equal(sends, 1)
  assert.equal(admitted.pending!.id, originalID); assert.equal(admitted.pending!.messageID, originalMessageID); assert.equal(admitted.pending!.coordinatorSessionID, originalRootID)
  assert.equal((await status(request.requestID)).pending, false)
  assert.equal((await status(request.requestID)).document!.control!.pending, false)
  assert.deepEqual(f.calls, [])
})
