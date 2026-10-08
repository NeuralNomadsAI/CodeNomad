import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { Context, DateTime, Effect, Exit, Schema, Scope } from "effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { authorityDigest, authoritySignerDigest, MISSION_AUTHORITY_POLICY, type ProvisionedAuthoritySigner } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { RECURRENCE_AUTHORITY_POLICY, recurrenceHumanRequestID, recurrenceStandingSigningBytes,
  type SignedRecurrenceStandingIntent } from "../../missions/recurrence-authority-contract"
import { RECURRENCE_STORAGE_PREFIX, type RecurrenceDocument } from "../../missions/recurrence-contract"
import { NativeRecurrenceAuthorityStore } from "../../missions/recurrence-authority-store"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { recurrenceSourceLocationDigest } from "../../missions/recurrence-input"
import { recurrenceSourceCursors } from "../../missions/recurrence-input"
import { RecurrenceAuthority } from "../../missions/recurrence-authority-core"
import type { MissionStorage } from "../../missions/journal"
import { physical } from "../../missions/host-authority/private-files"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { acquireMissionNativeService, type NativeCreateInput, type NativeRecurrenceLifecycleCommand } from "./native-service-adapter"
import { applyNativeStandingDecision, nativeRecurrenceAdapter, type NativeStandingSigner } from "./native-recurrence-adapter"
import { admitNativeRecurrencePassage, settleNativeRecurrencePassage } from "./native-recurrence-admission"
import type { NativeRecurrenceAuthorityProvider } from "./native-authority-provider"

const sessionTag = Context.Service<never, unknown>("@opencode/Session")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const current = () => true as const

// Offline native graph stand-in. Production read implementation is acquired unchanged.
async function fixture(inboxMessages = 2, effects = 8, streaming = false) {
  const temporary = await mkdtemp(path.join(process.env.TEMP!, "opencode", "watched-offline-"))
  execFileSync("git", ["init", "-q", temporary])
  const directory = realpathSync(temporary), family = await readFamilyAuthorityIdentity(directory)
  const root = { mode: "git" as const, directory, checkout: physical(directory), family }
  const scope = { namespace: "9f6f590e-271d-477f-8c02-7a6a119d63b9", projectID: "project", projectCanonical: directory,
    profileID: "profile", executionHost: "host", scheduleID: "daily-review", daemonStorageID: "offline" }
  const profile = { profileID: scope.profileID, executionHost: scope.executionHost, configYamlPath: path.join(directory, "config.yaml") }
  await writeFile(profile.configYamlPath, "server:\n  environmentVariables: {}\n")
  const values = new Map<string, unknown>([[`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, scope.namespace]])
  let failReceipt = false, deleteAnchorDuringQuery = false
  const storage: MissionStorage = {
    get: async key => values.get(key) as never,
    set: async (key, value, fence) => {
      fence?.()
      const child = (value as unknown as { child?: { effects: { receipt?: { sourceMessages?: unknown } }[] } }).child
      if (failReceipt && child?.effects.some(item => item.receipt?.sourceMessages)) throw Error("unknown read receipt ACK")
      values.set(key, structuredClone(value))
    },
    scan: async ({ prefix, after, limit }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value: value as never })) }),
  }
  const calendar = new NativeMissionRecurrenceStore(storage, scope.projectID, directory)
  const sourceKey = `${RECURRENCE_STORAGE_PREFIX}/project/${calendar.projectToken}/${scope.scheduleID}`
  const config: RecurrenceDocument["config"] = { template: "custom", consigne: "Review new replies", clock: { time: "07:00", zone: "UTC" },
    profileID: scope.profileID, executionHost: scope.executionHost, roots: [root], profiles: {
      coordinator: { agent: "build", model: { providerID: "fixture", id: "model" } },
      roles: { specialist: { agent: "build", model: { providerID: "fixture", id: "model" } } } },
    taskMode: "native", watchedConversationIDs: ["ses_watched"], publication: { policy: "disabled", conversationIDs: [] } }
  await calendar.create(scope.scheduleID, config, 1, current)
  const store = new NativeRecurrenceAuthorityStore(storage, scope), keys = generateKeyPairSync("ed25519")
  const signer: ProvisionedAuthoritySigner = { ...scope, authorityID: "authority", keyID: "key", roots: [root], publicKey: keys.publicKey,
    provisioningGeneration: "generation", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" as const }
  let parent: SignedRecurrenceStandingIntent
  const trust: NativeStandingSigner = { readSigners: async () => [signer], assertSignerCurrent: current,
    captureHumanIntent: signed => () => { assert.deepEqual(signed, parent); return true },
    assertProtectedCurrent: request => { assert.deepEqual(request.parent, parent); assert.deepEqual(request.ledger, values.get(store.key) ?? null); return true } }
  const owner = { namespace: scope.namespace, daemonStorageID: scope.daemonStorageID, assertCurrent: current }
  const familyClaims = new Map([[family, { assertCurrentSync: current, assertCurrent: async () => {}, release: async () => {} }]])
  const sessions = new Map<string, { id: string; projectID: string; location: { directory: string }; metadata?: Record<string, unknown>;
    title?: string; agent?: string; model?: { providerID: string; id: string } }>([["ses_watched", { id: "ses_watched", projectID: scope.projectID, location: { directory } }]])
  const admissions = new Map<string, NativeRecurrenceLifecycleCommand["input"]>()
  const noRoute = new Set<string>()
  let admissionFailure: unknown
  const readCalls: { sessionID: string; limit: number; cursor?: { id: string; direction: string }; order: string }[] = []
  const replies: { id: string; text: string; assistant?: boolean; completed?: boolean }[] = [{ id: "msg_one", text: "First new reply" },
    streaming ? { id: "msg_stream", text: "Partial streaming reply", assistant: true, completed: false } : { id: "msg_two", text: "Second new reply" }]
  const info = (id: string) => Schema.decodeUnknownSync(Session.Info)({ ...sessions.get(id), cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } })
  const message = (reply: typeof replies[number]) => Schema.decodeUnknownSync(SessionMessage.Info)(reply.assistant
    ? { id: reply.id, type: "assistant", agent: "build", model: { providerID: "fixture", id: "model" },
      content: [{ type: "text", text: reply.text }], time: { created: 1, ...(reply.completed ? { completed: 3 } : {}) } }
    : { id: reply.id, text: reply.text, type: "user", time: { created: 1 } })
  const service = { get: (id: string) => Effect.sync(() => info(id)), create: () => Effect.die("unexpected source create"),
    environment: () => Effect.succeed({}), inbox: () => Effect.succeed([]), prompt: () => Effect.die("unexpected source prompt"),
    synthetic: () => Effect.die("unexpected source synthetic"),
    message: (input: { messageID: string }) => Effect.succeed(replies.find(reply => reply.id === input.messageID) ? message(replies.find(reply => reply.id === input.messageID)!) : undefined),
    messages: (input: typeof readCalls[number]) => Effect.promise(async () => {
      readCalls.push(input)
      await Promise.resolve()
      if (deleteAnchorDuringQuery && input.cursor) {
        const index = replies.findIndex(reply => reply.id === input.cursor!.id)
        if (index >= 0) replies.splice(index, 1)
        return []
      }
      return replies.slice(input.cursor ? replies.findIndex(reply => reply.id === input.cursor!.id) + 1 : 0).slice(0, input.limit).map(message)
    }) }
  const effectScope = await Effect.runPromise(Scope.make())
  const sourceNative = await Effect.runPromise(acquireMissionNativeService().pipe(Effect.provideService(sessionTag, service),
    Effect.provideService(locationTag, Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: scope.projectID, directory, canonical: directory } })),
    Effect.provideService(Scope.Scope, effectScope)))
  const provider = { store, sourceKey, daemonStorageID: scope.daemonStorageID,
    location: { directory, projectID: scope.projectID, projectCanonical: directory }, assertCurrent: current,
    read: () => store.read(), readCurrent: (key: string) => values.get(key),
    transact: async <A>(fence: () => true, operation: () => Promise<A>) => { fence(); return operation() },
    assertSourcePlacement: (id: string, expected: { directory: string; workspaceID?: string }) => {
      assert.equal(sessions.get(id)?.projectID, scope.projectID, "source project changed")
      assert.deepEqual(sessions.get(id)?.location, expected.workspaceID === undefined ? { directory: expected.directory } : expected, "source moved")
      return true
    },
    readJournalWatermark: () => "offline-head", assertJournalWatermark: current, assertSessionWatermarks: current, assertNoPendingRequests: async () => true,
    readSession: (id: string) => {
      const admitted = admissions.get(id)!, session = sessions.get(id)!
      const events = [
        { type: "session.created.1", data: { sessionID: id } },
        { type: "session.inbox.enqueued.1", data: { sessionID: id, inboxID: admitted.id, item: { type: "synthetic", payload: admitted } } },
        { type: "session.execution.started.1", data: { sessionID: id } },
        { type: "session.inbox.delivered.1", data: { sessionID: id, inboxID: admitted.id } },
        noRoute.has(id) ? { type: "session.execution.failed.1", data: { sessionID: id, error: { type: "provider.no-route" } } }
          : { type: "session.execution.succeeded.1", data: { sessionID: id } },
      ].map((event, seq) => ({ id: `evt_${seq}`, seq, type: event.type, data: JSON.stringify(event.data) }))
      return { session: { id, project_id: scope.projectID, directory, workspace_id: null, parent_id: null,
        time_suspended: null, metadata: JSON.stringify(session.metadata) }, seq: 4, ownerID: null, inbox: 0, pending: 0,
        events, messages: [], message: { id: admitted.id, type: "synthetic", session_id: id, data: JSON.stringify(admitted) } }
    },
  } as unknown as NativeRecurrenceAuthorityProvider
  const native = { location: sourceNative.location, assertCurrent: current,
    get: async ({ sessionID }: { sessionID: string }) => { const target = sessions.get(sessionID); if (!target) throw Error("missing source"); return target },
    sourceMessages: sourceNative.sourceMessages,
    create: async (request: NativeCreateInput, _options: unknown, fence: () => true) => { fence(); const target = { ...request, projectID: scope.projectID }; sessions.set(request.id, target); return target },
    environment: async (_request: unknown, _options: unknown, fence: () => true) => { fence() },
    admit: async (command: NativeRecurrenceLifecycleCommand, _options: unknown, fence: () => true) => {
      try { fence() } catch (error) { admissionFailure = error; throw error }
      admissions.set(command.input.sessionID, command.input)
      return { id: command.input.id, sessionID: command.input.sessionID, type: "synthetic", delivery: "queue", time: { created: DateTime.makeUnsafe(1) },
        payload: { text: command.input.text, description: command.input.description, metadata: command.input.metadata } }
    } }
  const authorize = async () => {
    const hot = await store.read(), doc = (await calendar.read(scope.scheduleID))!, epoch = (hot?.parent.body.epoch ?? 0) + 1
    const body = { ...scope, authorityID: "authority", keyID: "key", roots: [root], version: 1 as const, policy: RECURRENCE_AUTHORITY_POLICY,
      action: "authorize" as const, scheduleRevision: doc.scheduleRevision, epoch, expectedRevision: hot?.revision ?? null,
      requestID: recurrenceHumanRequestID(scope.scheduleID, epoch, "authorize"), provisioningGeneration: "generation",
      signerDigest: authoritySignerDigest(keys.publicKey), config: doc.config, configDigest: authorityDigest(doc.config), profileSource: profile,
      budgets: { effects, nativeCalls: 0, inboxMessages, publications: 0 } }
    parent = { body, signature: sign(null, recurrenceStandingSigningBytes(body), keys.privateKey).toString("base64") }
    await applyNativeStandingDecision({ provider, signer: trust, owner }, parent, new AbortController().signal)
  }
  await authorize()
  const input = (document: RecurrenceDocument) => ({ document, provider, signer: trust, owner, familyClaims, storage, native: native as never,
    profile, signal: new AbortController().signal, settlementSignal: new AbortController().signal, beforeEffect: async () => current })
  const reserve = async (at: number) => {
    const doc = (await calendar.read(scope.scheduleID))!
    return calendar.reserve(doc.id, doc.revision, { kind: "manual", requestID: `run_${at}`, expectedRevision: doc.revision, at }, at, current)
  }
  const admit = async (doc: RecurrenceDocument) => {
    let admitted
    try { admitted = await admitNativeRecurrencePassage(input(doc)) }
    catch (error) { throw admissionFailure ?? error }
    return calendar.recordAdmission(doc.id, admitted, doc.pending!.passage.createdAt, current)
  }
  const finish = async (doc: RecurrenceDocument, at: number) => {
    const journal = recurrencePassage(storage, doc, current).journal
    await journal.append({ version: 1, id: `evt_finish_${at}`, type: "mission.finished", projectID: scope.projectID,
      missionID: doc.pending!.admission!.missionID, createdAt: at, outcome: "completed", summary: "Native passage result" })
    return settleNativeRecurrencePassage({ ...input(doc), now: () => at }, calendar)
  }
  const failBeforeModel = async (doc: RecurrenceDocument, at: number) => {
    const hot = (await store.read())!, child = hot.child!
    noRoute.add(child.grant.coordinatorSessionID)
    const journal = recurrencePassage(storage, doc, current).journal
    await journal.append({ version: 1, id: `evt_failed_${at}`, type: "mission.finished", projectID: scope.projectID,
      missionID: child.grant.missionID, createdAt: at, outcome: "failed", summary: "provider.no-route before model/tool work" })
    // Offline terminal-producer stand-in, not a new production failure observer.
    // Archive the real signed child/charged native read receipts through the core.
    const adapter = nativeRecurrenceAdapter(input(doc))
    const authority = new RecurrenceAuthority(store, { ...adapter, observeSettlement: async original => {
      assert.deepEqual(original, child)
      const nativeRead = provider.readSession(child.grant.coordinatorSessionID, child.grant.messageID)
      assert.equal(nativeRead.events.at(-1)?.type, "session.execution.failed.1")
      assert.equal(JSON.parse(String(nativeRead.events.at(-1)?.data)).error.type, "provider.no-route")
      assert(!nativeRead.events.some(event => /session\.(step|tool|shell)\./.test(String(event.type))))
      assert.equal(nativeRead.inbox, 0); assert.equal(nativeRead.pending, 0); assert.equal(nativeRead.ownerID, null)
      assert(original.effects.every(effect => effect.receipt?.outcome === "applied"))
      return { settlement: { grantID: child.grant.grantID, evidenceID: String(nativeRead.events.at(-1)!.id),
        outcome: "failed", effects: original.effects.map(effect => effect.receipt!), nativeIdle: true,
        controlsSettled: true, notificationsSettled: true, derivedCallsEnded: true }, assertCurrent: current }
    } })
    const archive = await provider.transact(current, () => authority.settle(child.grant.grantID, hot.revision, new AbortController().signal))
    return { archive, document: await settleNativeRecurrencePassage({ ...input(doc), now: () => at }, calendar) }
  }
  return { calendar, store, readCalls, replies, sessions, admissions, authorize, reserve, admit, finish, failBeforeModel,
    failReceipt: () => { failReceipt = true }, deleteAnchorDuringQuery: () => { deleteAnchorDuringQuery = true }, directory,
    close: async () => { await Effect.runPromise(Scope.close(effectScope, Exit.void)); await rm(temporary, { recursive: true, force: true }) } }
}

test("two finite passages read only new source replies; next-day archive owns cursor advancement and removed/readded sources retain it", async () => {
  const f = await fixture()
  try {
    const first = await f.admit(await f.reserve(10))
    assert.deepEqual(first.cursors, [], "admission is not processed output")
    assert([...f.admissions.values()][0].text.startsWith("Review new replies\n\n"))
    assert([...f.admissions.values()][0].text.includes("msg_one"))
    assert.equal((await f.store.read())?.child?.effects[0].effect.kind, "inbox-read")
    const archived = await f.finish(first, 11)
    assert.equal(archived.cursors[0].messageID, "msg_two")
    assert.equal(archived.cursors[0].locationDigest, recurrenceSourceLocationDigest({ directory: f.directory }))
    f.replies.push({ id: "msg_three", text: "Next-day new reply" })
    const second = await f.admit(await f.reserve(86_410))
    assert.equal(f.readCalls[1].cursor?.id, "msg_two")
    const input = [...f.admissions.values()].at(-1)!.text
    assert(input.includes("msg_three")); assert(!input.includes("First new reply"))
    f.sessions.get("ses_watched")!.location.directory += "-moved"
    await assert.rejects(f.finish(second, 86_411), /source moved/)
    assert.equal((await f.calendar.read(second.id))?.cursors[0].messageID, "msg_two")
    f.sessions.get("ses_watched")!.location.directory = f.directory
    // The completed journal survives the failed observation; settlement does not redispatch.
    const settled = await f.finish(second, 86_411)
    assert.equal(settled.cursors[0].messageID, "msg_three")
    const removed = await f.calendar.configure(settled.id, settled.revision, { ...settled.config, watchedConversationIDs: [] }, current)
    await f.authorize()
    const noWatch = await f.finish(await f.admit(await f.reserve(172_810)), 172_811)
    assert.equal(f.readCalls.length, 2)
    assert.equal(noWatch.cursors[0].messageID, "msg_three")
    await f.calendar.configure(removed.id, noWatch.revision, { ...noWatch.config, watchedConversationIDs: ["ses_watched"] }, current)
    await f.authorize()
    f.replies.push({ id: "msg_four", text: "Reply after readding" })
    const readded = await f.admit(await f.reserve(259_210))
    assert.equal(f.readCalls[2].cursor?.id, "msg_three")
    assert.equal((await f.finish(readded, 259_211)).cursors[0].messageID, "msg_four")
    const raced = await f.reserve(345_610)
    f.deleteAnchorDuringQuery()
    await assert.rejects(f.admit(raced), /observation-unavailable/)
    assert.equal((await f.store.read())?.child?.effects[0].receipt, null, "anchor deletion cannot produce a positive empty-page receipt")
    const unknown = (await f.calendar.read(raced.id))!
    assert.equal(unknown.cursors[0].messageID, "msg_four", "unknown read cannot advance or reset the archived cursor")
    assert.equal(unknown.pending?.admission, null)
    assert.equal(f.readCalls.length, 4)
    await assert.rejects(f.admit(raced))
    assert.equal(f.readCalls.length, 4, "no retry or replacement read after lost anchor")
  } finally { await f.close() }
})

test("zero signed read budget and unknown read receipt leave the passage pending without replay or cursor advance", async () => {
  for (const [budget, effects] of [[0, 8], [2, 3], [2, 8]]) {
    const failReceipt = budget === 2 && effects === 8
    const f = await fixture(budget, effects)
    try {
      const doc = await f.reserve(10)
      if (failReceipt) f.failReceipt()
      await assert.rejects(f.admit(doc), failReceipt ? /unknown read receipt ACK/ : /insufficient signed source budget/)
      const hot = await f.store.read()
      assert.equal(f.readCalls.length, failReceipt ? 1 : 0)
      assert.equal(f.sessions.size, 1, "insufficient budget never creates a coordinator")
      if (failReceipt) assert.equal(hot?.child?.effects[0].receipt, null)
      await assert.rejects(f.admit(doc))
      assert.equal(f.readCalls.length, failReceipt ? 1 : 0)
      const pending = (await f.calendar.read(doc.id))!
      assert.deepEqual(pending.cursors, []); assert.equal(pending.pending?.admission, null)
    } finally { await f.close() }
  }
})

test("busy source's partial assistant is deferred; final same ID appears exactly once in the next archived passage", async () => {
  const f = await fixture(2, 8, true)
  try {
    const first = await f.admit(await f.reserve(10))
    assert(![...f.admissions.values()][0].text.includes("Partial streaming reply"))
    const firstRead = (await f.store.read())!.child!.effects[0].receipt!
    assert.deepEqual(firstRead.sourceMessages?.map(item => item.id), ["msg_one"])
    assert.equal((await f.finish(first, 11)).cursors[0].messageID, "msg_one", "partial assistant ID must not become processed")
    const reply = f.replies.find(item => item.id === "msg_stream")!
    reply.text = "Final stable native reply"; reply.completed = true
    const second = await f.admit(await f.reserve(86_410))
    assert.equal(f.readCalls[1].cursor?.id, "msg_one")
    const completed = (await f.store.read())!.child!.effects[0].receipt!.sourceMessages!
    assert.deepEqual(completed.map(item => item.id), ["msg_stream"])
    assert.equal(completed[0].text, "Final stable native reply")
    assert.equal(completed[0].completedAt, 3)
    assert.match(completed[0].nativeDigest, /^[a-f0-9]{64}$/)
    assert.equal(second.cursors[0].messageID, "msg_one", "even positive completed reads await archive")
    assert.equal((await f.finish(second, 86_411)).cursors[0].messageID, "msg_stream")
    const third = await f.admit(await f.reserve(172_810))
    assert.equal(f.readCalls[2].cursor?.id, "msg_stream")
    assert.deepEqual((await f.store.read())!.child!.effects[0].receipt!.sourceMessages, [])
    assert(![...f.admissions.values()].at(-1)!.text.includes("Final stable native reply"))
    assert.equal((await f.finish(third, 172_811)).cursors[0].messageID, "msg_stream")
  } finally { await f.close() }
})

test("daily review admits full multi-KiB native replies; oversized source needsDecision archives without consuming that cursor", async () => {
  const f = await fixture(2, 8, true)
  try {
    let previousCursor = "msg_one"
    for (const [index, length] of [2 * 1024, 4 * 1024, 8 * 1024].entries()) {
      const reply = index === 0 ? f.replies[1] : { id: `msg_complete_${index}`, text: "", assistant: true, completed: true }
      reply.text = "x".repeat(length); reply.completed = true
      if (index) f.replies.push(reply)
      const admitted = await f.admit(await f.reserve(10 + index * 86_400))
      const input = [...f.admissions.values()].at(-1)!.text
      assert(input.includes(reply.text)); assert(input.length <= 16_384)
      const messages = (await f.store.read())!.child!.effects[0].receipt!.sourceMessages!
      assert.equal(messages.find(item => item.id === reply.id)?.text, reply.text)
      assert.equal(messages.find(item => item.id === reply.id)?.needsDecision, undefined)
      const archived = await f.finish(admitted, 11 + index * 86_400)
      assert.equal(archived.cursors[0].messageID, reply.id)
      previousCursor = reply.id
    }
    const huge = { id: "msg_needs_decision", text: "z".repeat(20 * 1024), assistant: true, completed: true }
    f.replies.push(huge)
    const admitted = await f.admit(await f.reserve(259_210))
    const input = [...f.admissions.values()].at(-1)!.text
    assert(input.includes(huge.id)); assert(input.includes("source-input-capacity"))
    assert(!input.includes(huge.text)); assert(input.length <= 16_384)
    const reference = (await f.store.read())!.child!.effects[0].receipt!.sourceMessages![0]
    assert.equal(reference.id, huge.id); assert.equal(reference.needsDecision, "source-input-capacity")
    assert.equal(reference.text, "")
    const archived = await f.finish(admitted, 259_211)
    assert.equal(archived.cursors[0].messageID, previousCursor, "exact overlarge reference is not processed output")
  } finally { await f.close() }
})

test("provider failure after charged source reads before model work preserves cursors; next-day completed review sees those replies", async () => {
  const f = await fixture()
  try {
    const baseline = await f.finish(await f.admit(await f.reserve(10)), 11)
    const originalCursors = structuredClone(baseline.cursors)
    f.replies.push({ id: "msg_not_handled", text: "Reply read before provider failure", assistant: true, completed: true })
    const failedInput = await f.admit(await f.reserve(86_410))
    assert([...f.admissions.values()].at(-1)!.text.includes("Reply read before provider failure"))
    const { archive, document: failed } = await f.failBeforeModel(failedInput, 86_411)
    assert.equal(archive.settlement.outcome, "failed")
    const read = archive.child.effects[0]
    assert.equal(read.effect.kind, "inbox-read")
    assert(read.effect.kind === "inbox-read" && read.effect.read?.limit === 2, "old signed read budget stays charged")
    assert.deepEqual(read.receipt!.sourceMessages!.map(item => item.id), ["msg_not_handled"])
    assert.deepEqual(recurrenceSourceCursors(archive), [])
    assert.deepEqual(failed.cursors, originalCursors)
    assert.equal(failed.pending, null)
    const oldEffects = structuredClone(archive.child.effects)
    const reads = f.readCalls.length
    await assert.rejects(f.admit(failedInput))
    assert.equal(f.readCalls.length, reads, "original failed passage cannot replay its read or native effects")
    assert.deepEqual((await f.store.readPassage(archive.child.grant.passage.id))!.child.effects, oldEffects)
    const next = await f.admit(await f.reserve(172_810))
    assert.equal(f.readCalls.at(-1)?.cursor?.id, originalCursors[0].messageID)
    assert([...f.admissions.values()].at(-1)!.text.includes("Reply read before provider failure"))
    assert.deepEqual(next.cursors, originalCursors, "a second ACK is still not completed model processing")
    assert.equal((await f.finish(next, 172_811)).cursors[0].messageID, "msg_not_handled")
  } finally { await f.close() }
})
