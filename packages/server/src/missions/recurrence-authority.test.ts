import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import test from "node:test"
import { authorityDigest, authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY,
  type ProvisionedAuthoritySigner } from "./authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "./authority-store"
import { type MissionStorage } from "./journal"
import { type MissionJsonValue } from "./model"
import { RECURRENCE_STORAGE_PREFIX, type RecurrenceConfig } from "./recurrence-contract"
import { NativeMissionRecurrenceStore } from "./recurrence-store"
import { authenticateRecurrenceStanding, recurrenceEffectID, recurrenceHumanRequestID, recurrenceStandingSigningBytes, RECURRENCE_AUTHORITY_POLICY, RECURRENCE_AUTHORITY_MAX_BYTES,
  type RecurrenceAuthorityScope, type RecurrenceChildRecord, type RecurrenceEffect, type RecurrenceEffectReceipt,
  type RecurrenceSettlement, type RecurrenceStandingIntent, type SignedRecurrenceStandingIntent } from "./recurrence-authority-contract"
import { RecurrenceAuthority, recurrenceQualificationDigest, type RecurrenceAuthorityAdapter, type RecurrenceQualificationRequest } from "./recurrence-authority-core"
import { NativeRecurrenceAuthorityStore, type RecurrenceAuthorityDocument } from "./recurrence-authority-store"

const namespace = "9f6f590e-271d-477f-8c02-7a6a119d63b9"
const root = { mode: "git" as const, directory: "/owned/project", family: "family", checkout: "/owned/project" }
const execution = { agent: "worker", model: { providerID: "provider", id: "model" } }
const config: RecurrenceConfig = { template: "custom", consigne: "Review", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
  profiles: { coordinator: execution, roles: { specialist: execution } }, taskMode: "native", roots: [root],
  watchedConversationIDs: ["ses_watched"], publication: { policy: "authorized-targets", conversationIDs: ["ses_target"] } }
const scope: RecurrenceAuthorityScope = { namespace, projectID: "project", projectCanonical: "/owned/project", profileID: "profile",
  executionHost: "host", scheduleID: "daily_review", daemonStorageID: "native_storage" }
const signal = () => new AbortController().signal
const same = (a: unknown, b: unknown) => canonicalAuthority(a, 256 * 1024) === canonicalAuthority(b, 256 * 1024)

/** Structural isolated fixture ONLY. The real protected native-parent proof,
 * synchronous native ledger reader and original invocation producer are external
 * integration gates, never supplied by production code in these modules. */
async function fixture() {
  const keys = generateKeyPairSync("ed25519"), values = new Map<string, MissionJsonValue>()
  values.set(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, namespace)
  const signer: ProvisionedAuthoritySigner = { ...scope, roots: [root], authorityID: "authority", keyID: "key",
    publicKey: keys.publicKey, provisioningGeneration: "generation", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }
  let signers = [signer], managed = true, human = true, nativeStorageID = scope.daemonStorageID, effects = 0
  let prepare: (key: string) => void = () => {}, failAfter: string | undefined
  let qualifier: (request: Readonly<RecurrenceQualificationRequest>) => void = () => {}
  const receipts = new Map<string, RecurrenceEffectReceipt>(), settlements = new Map<string, RecurrenceSettlement>()
  const humanReservations = new Set<string>(), writes: string[] = []
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value, current) => {
      prepare(key); current?.(); values.set(key, structuredClone(value)); writes.push(key)
      if (failAfter === key) { failAfter = undefined; throw new Error("ACK lost after native publication") }
    },
    scan: async ({ prefix, after, limit = 100 }) => {
      const all = [...values].filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after)).sort(([a], [b]) => a < b ? -1 : 1)
      const entries = all.slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries, ...(all.length > limit ? { next: entries.at(-1)!.key } : {}) }
    },
  }
  const store = new NativeRecurrenceAuthorityStore(storage, scope)
  const source = new NativeMissionRecurrenceStore(storage, scope.projectID, scope.projectCanonical)
  const sourceKey = `${RECURRENCE_STORAGE_PREFIX}/project/${source.projectToken}/${scope.scheduleID}`
  const qualifiedCurrent = (): true => {
    assert.equal(managed, true, "qualified native writer disappeared")
    assert.equal(nativeStorageID, scope.daemonStorageID, "native storage incarnation changed")
    assert.equal(values.get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`), namespace)
    return true
  }
  const adapter: RecurrenceAuthorityAdapter = {
    readSigners: async () => signers,
    assertSignerCurrent: snapshot => {
      qualifiedCurrent()
      const current = signers.filter(item => item.authorityID === snapshot.authorityID && item.keyID === snapshot.keyID)
      assert.equal(current.length, 1)
      assert.equal(current[0].qualification, "qualified")
      assert.equal(current[0].provisioningGeneration, snapshot.provisioningGeneration)
      assert.equal(authoritySignerDigest(current[0].publicKey), snapshot.signerDigest)
      assert(same(current[0].roots, snapshot.roots))
      return true
    },
    qualify: async request => {
      qualifier(request)
      const assertCurrent = (): true => {
        qualifiedCurrent(); assert(same(request.scope, scope))
        if (request.purpose === "human") { assert(human); assert(humanReservations.has(authorityDigest(request.parent))) }
        if (request.purpose === "reserve") assert(same(request.document, values.get(sourceKey)), "not the actual stored pending passage")
        if (["reserve", "effect"].includes(request.purpose)) assert.equal(values.has(`${store.parentKey}/parents/${request.parent.body.epoch + 1}`), false)
        return true
      }
      assertCurrent()
      return { requestDigest: recurrenceQualificationDigest(request), assertCurrent }
    },
    assertLedgerCurrent: (target, expected) => {
      qualifiedCurrent(); assert.equal(target, store)
      assert(same(values.get(store.key) ?? null, expected), "native ledger changed")
      return true
    },
    assertEffectCurrent: (target, child, operation) => {
      qualifiedCurrent(); assert.equal(target, store)
      assert.equal(values.has(`${store.parentKey}/passages/${child.grant.passage.id}`), false, "passage already archived")
      const ledger = values.get(store.key) as unknown as RecurrenceAuthorityDocument
      assert.equal(ledger.parent.body.action, "authorize")
      assert.equal(values.has(`${store.parentKey}/parents/${ledger.parent.body.epoch + 1}`), false, "pending protected parent decision")
      assert(same(ledger.child, child)); assert(child.effects.some(item => same(item, operation)))
      return true
    },
    observeEffect: async (_child, operation) => {
      const receipt = structuredClone(receipts.get(operation.operationID))
      if (!receipt) throw new Error("native outcome unknown")
      return { receipt, assertCurrent: () => { qualifiedCurrent(); assert(same(receipts.get(operation.operationID), receipt)); return true } }
    },
    observeSettlement: async child => {
      const settlement = structuredClone(settlements.get(child.grant.grantID))
      if (!settlement) throw new Error("native execution unsettled")
      return { settlement, assertCurrent: () => { qualifiedCurrent(); assert(same(settlements.get(child.grant.grantID), settlement)); return true } }
    },
  }
  const core = new RecurrenceAuthority(store, adapter)
  let now = Date.parse("2026-10-01T06:00:00Z")
  await source.create(scope.scheduleID, config, now, qualifiedCurrent)
  const paused = (await source.read(scope.scheduleID))!
  await source.setState(scope.scheduleID, paused.revision, "running", qualifiedCurrent)
  async function signed(overrides: Partial<RecurrenceStandingIntent> = {}): Promise<SignedRecurrenceStandingIntent> {
    const previous = await store.read()
    const selected = overrides.config ?? previous?.parent.body.config ?? config
    const epoch = overrides.epoch ?? (previous?.parent.body.epoch ?? 0) + 1, action = overrides.action ?? "authorize"
    const body: RecurrenceStandingIntent = { ...scope, authorityID: signer.authorityID, keyID: signer.keyID, roots: selected.roots,
      version: 1, policy: RECURRENCE_AUTHORITY_POLICY, action: "authorize", scheduleRevision: previous?.parent.body.scheduleRevision ?? 0,
      epoch, expectedRevision: previous?.revision ?? null, requestID: recurrenceHumanRequestID(scope.scheduleID, epoch, action),
      provisioningGeneration: signer.provisioningGeneration, signerDigest: authoritySignerDigest(signer.publicKey),
      config: selected, configDigest: authorityDigest(selected), profileSource: { profileID: scope.profileID,
        executionHost: scope.executionHost, configYamlPath: "/owned/profile/config.yaml" },
      budgets: { effects: 16, nativeCalls: 2, inboxMessages: 3, publications: 2 }, ...overrides }
    return { body, signature: sign(null, recurrenceStandingSigningBytes(body), keys.privateKey).toString("base64") }
  }
  async function authorize(overrides: Partial<RecurrenceStandingIntent> = {}) {
    const intent = await signed(overrides); humanReservations.add(authorityDigest(intent))
    return core.authorize(intent, signal())
  }
  async function reserve() {
    const doc = (await source.read(scope.scheduleID))!
    const pending = await source.reserve(doc.id, doc.revision, { kind: "manual", expectedRevision: doc.revision,
      requestID: `manual_${doc.settledCount}`, at: ++now }, now, qualifiedCurrent)
    return core.reservePassage(pending, (await store.read())!.revision, signal())
  }
  async function claim(grantID: string, effect: RecurrenceEffect) {
    return core.reserveEffect(grantID, effect, (await store.read())!.revision, signal())
  }
  function invoke(lease: Awaited<ReturnType<typeof claim>>) {
    lease.assertCurrent(); effects++
    const receipt: RecurrenceEffectReceipt = { operationID: lease.operation.operationID, outcome: "applied", evidenceID: `ev_${lease.operation.operationID}` }
    receipts.set(receipt.operationID, receipt)
  }
  async function acknowledge(grantID: string, operationID: string) {
    return core.acknowledgeEffect(grantID, operationID, (await store.read())!.revision, signal())
  }
  function terminal(child: RecurrenceChildRecord, outcome: RecurrenceSettlement["outcome"] = "completed") {
    settlements.set(child.grant.grantID, { grantID: child.grant.grantID, evidenceID: `terminal_${child.grant.sequence}`, outcome,
      effects: child.effects.map(operation => {
        const receipt = receipts.get(operation.operationID)
        if (!receipt) throw new Error("fixture cannot fabricate unknown outcome")
        return structuredClone(receipt)
      }), nativeIdle: true, controlsSettled: true, notificationsSettled: true, derivedCallsEnded: true })
  }
  async function finishSource(outcome: "completed" | "failed" | "stopped" = "completed") {
    const doc = (await source.read(scope.scheduleID))!, grant = (await store.read())!.settledSequence
    const missionID = `msn_fixture_${grant}`
    await source.recordAdmission(doc.id, { kind: "accepted", passageID: doc.pending!.passage.id,
      messageID: doc.pending!.passage.messageID, missionID, conversationID: "ses_fixture" }, ++now, qualifiedCurrent)
    return source.finish(doc.id, { passageID: doc.pending!.passage.id, messageID: doc.pending!.passage.messageID,
      missionID, conversationID: "ses_fixture", outcome, artifactMessageIDs: [], cursors: [] }, ++now, qualifiedCurrent)
  }
  return { keys, signer, store, source, sourceKey, storage, values, writes, adapter, core, signed, authorize, reserve, claim, invoke, acknowledge,
    terminal, finishSource, receipts, settlements, humanReservations, qualifiedCurrent,
    effects: () => effects, setManaged: (value: boolean) => { managed = value }, setHuman: (value: boolean) => { human = value },
    setStorageID: (value: string) => { nativeStorageID = value }, setSigners: (value: ProvisionedAuthoritySigner[]) => { signers = value },
    prepare: (hook: typeof prepare) => { prepare = hook }, qualifier: (hook: typeof qualifier) => { qualifier = hook },
    failAfter: (key: string) => { failAfter = key } }
}

test("domain-separated trusted-map parent authentication; forged keys, scopes, policies and missing human reservation fail", async () => {
  const f = await fixture(), parent = await f.signed()
  const verified = authenticateRecurrenceStanding(parent, [f.signer])
  assert.equal(verified.signed.body.configDigest, authorityDigest(config))
  const ordinarySignature = sign(null, Buffer.from(`${MISSION_AUTHORITY_POLICY}\n${canonicalAuthority(parent.body)}`), f.keys.privateKey).toString("base64")
  assert.throws(() => authenticateRecurrenceStanding({ ...parent, signature: ordinarySignature }, [f.signer]))
  const attacker = generateKeyPairSync("ed25519")
  assert.throws(() => authenticateRecurrenceStanding({ ...parent, signature: sign(null,
    recurrenceStandingSigningBytes(parent.body), attacker.privateKey).toString("base64"), publicKey: attacker.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, [f.signer]))
  assert.throws(() => authenticateRecurrenceStanding(parent, []))
  assert.throws(() => authenticateRecurrenceStanding(parent, [f.signer, f.signer]))
  assert.throws(() => authenticateRecurrenceStanding(parent, [{ ...f.signer, projectID: "foreign" }]))
  assert.throws(() => authenticateRecurrenceStanding(parent, [{ ...f.signer, roots: [{ ...root, directory: "/foreign" }] }]))
  assert.throws(() => authenticateRecurrenceStanding(parent, [{ ...f.signer, qualification: "old-writer-unexcluded" }]))
  assert.throws(() => authenticateRecurrenceStanding({ ...parent, body: { ...parent.body, configDigest: "0".repeat(64) } }, [f.signer]))
  assert.throws(() => authenticateRecurrenceStanding({ ...parent, body: { ...parent.body, requestID: "other_human" } }, [f.signer]))
  assert.throws(() => authenticateRecurrenceStanding({ ...parent, body: { ...parent.body,
    profileSource: { ...parent.body.profileSource, configYamlPath: "/foreign/config.yaml" } } }, [f.signer]))
  assert.throws(() => authenticateRecurrenceStanding({ ...parent, body: { ...parent.body, requestID: undefined } }, [f.signer]))
  await assert.rejects(f.core.authorize(parent, signal()), /assertion|false == true/i)
  for (const change of [{ daemonStorageID: "other" }, { scheduleID: "other" }, { namespace: "c3dceeba-0e9f-4b6c-9445-81262411a2b8" }]) {
    const wrong = await f.signed(change); f.humanReservations.add(authorityDigest(wrong))
    await assert.rejects(f.core.authorize(wrong, signal()))
  }
  assert.equal(await f.store.read(), undefined)
  assert.equal(f.effects(), 0)
  await f.authorize()
})

test("exact authentic pending passage and frozen choices; unsigned/forged sources and stale revisions cannot reserve", async () => {
  const f = await fixture()
  await assert.rejects(f.reserve())
  await f.authorize()
  const pending = (await f.source.read(scope.scheduleID))!
  const changed = structuredClone(pending)
  changed.config.consigne = "Another objective"
  await assert.rejects(f.core.reservePassage(changed, (await f.store.read())!.revision, signal()))
  const forged = structuredClone(pending)
  forged.revision++
  await assert.rejects(f.core.reservePassage(forged, (await f.store.read())!.revision, signal()), /actual stored/)
  const grant = await f.core.reservePassage(pending, (await f.store.read())!.revision, signal())
  assert.equal(grant.passage.id, pending.pending!.passage.id)
  assert.equal(grant.messageID, pending.pending!.passage.messageID)
  assert.equal(grant.sequence, 1)
  await assert.rejects(f.core.reservePassage(pending, (await f.store.read())!.revision, signal()))
  await assert.rejects(f.core.reserveEffect(grant.grantID, { kind: "create" }, 0, signal()), /revision-conflict/)
  assert.equal(f.effects(), 0)
})

test("durable exact effect reservation, single-use fence and positive native ACK; unknown outcomes never replay", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  await assert.rejects(f.claim(grant.grantID, { kind: "start" }))
  const lease = await f.claim(grant.grantID, { kind: "create" })
  assert.equal((await f.store.read())!.child!.effects[0].receipt, null)
  await assert.rejects(f.claim(grant.grantID, { kind: "create" }), /authorization-blocked|request-conflict/)
  await assert.rejects(f.acknowledge(grant.grantID, lease.operation.operationID), /unknown/)
  f.invoke(lease)
  assert.throws(() => f.invoke(lease), /authorization-blocked/)
  await f.acknowledge(grant.grantID, lease.operation.operationID)
  const start = await f.claim(grant.grantID, { kind: "start" }); f.invoke(start)
  // Lost ACK is reconciled using exact terminal/native receipts, not a resend.
  f.terminal((await f.store.read())!.child!)
  const archive = await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
  assert.equal(archive.child.effects[1].receipt!.operationID, start.operation.operationID)
  assert.equal((await f.store.read())!.settledSequence, 1)
  assert.equal(f.effects(), 2)
  await assert.rejects(f.claim(grant.grantID, { kind: "create" }))
})

test("Pause/revoke and signer/native qualification changes fence prepared effects while preserving old evidence", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  const lease = await f.claim(grant.grantID, { kind: "create" })
  await f.authorize({ action: "pause" })
  assert.throws(() => f.invoke(lease), /policy-unqualified/)
  await assert.rejects(f.claim(grant.grantID, { kind: "create" }))
  await assert.rejects(f.authorize(), /authorization-blocked/)
  const receipt: RecurrenceEffectReceipt = { operationID: lease.operation.operationID, outcome: "rejected-before-effect", evidenceID: "native_no_effect" }
  f.receipts.set(receipt.operationID, receipt)
  await f.acknowledge(grant.grantID, receipt.operationID)
  await f.authorize({ action: "revoke" })
  f.setSigners([]) // historical evidence does not acquire a current signing key
  f.terminal((await f.store.read())!.child!, "rejected-before-effect")
  await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
  assert.equal((await f.store.read())!.parent.body.action, "revoke")
  assert.equal((await f.store.readPassage(grant.passage.id))!.settlement.outcome, "rejected-before-effect")
  await assert.rejects(f.authorize())
  assert.equal(f.effects(), 0)
  for (const change of ["managed", "storage", "signer"] as const) {
    const g = await fixture(); await g.authorize(); const child = await g.reserve(); const prepared = await g.claim(child.grantID, { kind: "create" })
    if (change === "managed") g.setManaged(false)
    if (change === "storage") g.setStorageID("replacement")
    if (change === "signer") g.setSigners([{ ...g.signer, provisioningGeneration: "replacement" }])
    assert.throws(() => g.invoke(prepared)); assert.equal(g.effects(), 0)
  }
})

test("a committed Pause after native entry preserves the original applied ACK despite dispatch cancellation", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  const create = await f.claim(grant.grantID, { kind: "create" })
  f.invoke(create)
  const dispatch = new AbortController(); dispatch.abort()
  await f.authorize({ action: "pause" })
  await assert.rejects(f.core.acknowledgeEffect(grant.grantID, create.operation.operationID,
    (await f.store.read())!.revision, dispatch.signal))
  const original = await f.core.acknowledgeEffect(grant.grantID, create.operation.operationID,
    (await f.store.read())!.revision, new AbortController().signal)
  assert.equal(original.operationID, create.operation.operationID)
  assert.equal(original.outcome, "applied")
  assert.equal(f.effects(), 1)
  await assert.rejects(f.claim(grant.grantID, { kind: "start" }), /authorization-blocked/)
})

test("signed initial coordinator message can be reserved once after start environment ACK", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  const create = await f.claim(grant.grantID, { kind: "create" }); f.invoke(create)
  await f.acknowledge(grant.grantID, create.operation.operationID)
  const start = await f.claim(grant.grantID, { kind: "start" }); f.invoke(start)
  await f.acknowledge(grant.grantID, start.operation.operationID)
  const message = { kind: "coordinator-message" as const, messageID: grant.messageID,
    contentDigest: "a".repeat(64) }
  const reserved = await f.claim(grant.grantID, message); f.invoke(reserved)
  await f.acknowledge(grant.grantID, reserved.operation.operationID)
  await assert.rejects(f.claim(grant.grantID, message), /request-conflict/)
  assert.equal(f.effects(), 3)
})

test("human reauthorization is CAS, monotonic and refuses outstanding children; stale snapshots cannot replenish budgets", async () => {
  const f = await fixture(); await f.authorize()
  const first = await f.signed(), second = await f.signed()
  for (const intent of [first, second]) f.humanReservations.add(authorityDigest(intent))
  const results = await Promise.allSettled([f.core.authorize(first, signal()), f.core.authorize(second, signal())])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  assert.equal((await f.store.read())!.parent.body.epoch, 2)
  await assert.rejects(f.core.authorize(first, signal()), /revision-conflict/)
  await assert.rejects(f.authorize({ action: "pause", profileSource: { profileID: scope.profileID,
    executionHost: scope.executionHost, configYamlPath: "/different/config.yaml" } }), /epoch-conflict/)
  await f.authorize({ action: "pause" })
  await f.authorize()
  const grant = await f.reserve()
  await assert.rejects(f.authorize())
  assert.equal((await f.store.read())!.child!.grant.grantID, grant.grantID)
})

test("native preparation races and non-synchronous/unbound leases cannot publish or invoke", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  f.prepare(key => { if (key === f.store.key) f.setManaged(false) })
  await assert.rejects(f.claim(grant.grantID, { kind: "create" }))
  assert.equal(f.effects(), 0); assert.equal((f.values.get(f.store.key) as unknown as RecurrenceAuthorityDocument).child!.effects.length, 0)
  const g = await fixture(); await g.authorize(); const child = await g.reserve()
  g.adapter.qualify = async () => ({ requestDigest: "0".repeat(64), assertCurrent: () => true })
  await assert.rejects(g.claim(child.grantID, { kind: "create" }), /policy-unqualified/)
  const h = await fixture(); await h.authorize(); const pending = await h.reserve()
  h.adapter.qualify = async request => ({ requestDigest: recurrenceQualificationDigest(request),
    assertCurrent: (() => Promise.resolve(true)) as unknown as () => true })
  await assert.rejects(h.claim(pending.grantID, { kind: "create" }), /policy-unqualified/)
  assert.equal((await h.store.read())!.child!.effects.length, 0)
  assert.throws(() => new RecurrenceAuthority(h.store, undefined as unknown as RecurrenceAuthorityAdapter), /policy-unqualified/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(h.core.reserveEffect(pending.grantID, { kind: "create" }, (await h.store.read())!.revision, controller.signal))
})

test("lost reservation/hot acknowledgements never return replacement effect leases or reset parent identity", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  f.failAfter(f.store.key)
  await assert.rejects(f.claim(grant.grantID, { kind: "create" }), /ACK lost/)
  const parked = (await f.store.read())!.child!
  assert.equal(parked.effects.length, 1); assert.equal(parked.effects[0].receipt, null)
  await assert.rejects(f.claim(grant.grantID, { kind: "create" }))
  await assert.rejects(f.core.settle(grant.grantID, (await f.store.read())!.revision, signal()), /unsettled/)
  // Explicit positive native no-effect evidence, not elapsed time or empty queues.
  f.receipts.set(parked.effects[0].operationID, { operationID: parked.effects[0].operationID,
    outcome: "rejected-before-effect", evidenceID: "original_admission_never_entered" })
  f.terminal(parked, "rejected-before-effect")
  f.failAfter(f.store.key)
  await assert.rejects(f.core.settle(grant.grantID, (await f.store.read())!.revision, signal()), /ACK lost/)
  assert.equal((await f.store.read())!.settledSequence, 1)
  assert.equal((await f.store.readPassage(grant.passage.id))!.settlement.outcome, "rejected-before-effect")
  assert.equal(f.effects(), 0)
  const g = await fixture(), parent = await g.signed(); g.humanReservations.add(authorityDigest(parent))
  g.failAfter(`${g.store.parentKey}/parents/1`)
  await assert.rejects(g.core.authorize(parent, signal()), /ACK lost/)
  assert.equal(await g.store.read(), undefined)
  await g.core.authorize(parent, signal()) // original signed decision, metadata-only reconciliation
  assert.equal((await g.store.read())!.parent.body.epoch, 1)
  assert.equal(g.effects(), 0)
})

test("finite per-passage budgets, watch/target scope and exact native execution choices", async () => {
  const f = await fixture(); await f.authorize({ budgets: { effects: 16, nativeCalls: 1, inboxMessages: 1, publications: 1 } })
  const grant = await f.reserve()
  const create = await f.claim(grant.grantID, { kind: "create" }); f.invoke(create); await f.acknowledge(grant.grantID, create.operation.operationID)
  const start = await f.claim(grant.grantID, { kind: "start" }); f.invoke(start); await f.acknowledge(grant.grantID, start.operation.operationID)
  const native: RecurrenceEffect = { kind: "native-call", taskKey: "task", generation: 1, parentSessionID: grant.coordinatorSessionID,
    parentMessageID: grant.messageID, toolCallID: "call", directory: root.directory, mode: "native", execution }
  await assert.rejects(f.claim(grant.grantID, { ...native, execution: { ...execution, agent: "other" } }))
  await assert.rejects(f.claim(grant.grantID, { ...native, directory: "/unowned" }))
  await assert.rejects(f.claim(grant.grantID, { ...native, mode: "independent" }))
  await f.claim(grant.grantID, native)
  await assert.rejects(f.claim(grant.grantID, { ...native, toolCallID: "second", taskKey: "second_task" }), /capacity/)
  await assert.rejects(f.claim(grant.grantID, { kind: "inbox-read", conversationID: "ses_other", messageIDs: ["msg"] }))
  await f.claim(grant.grantID, { kind: "inbox-read", conversationID: "ses_watched", messageIDs: ["msg"] })
  await assert.rejects(f.claim(grant.grantID, { kind: "inbox-read", conversationID: "ses_watched", messageIDs: ["msg_other"] }), /capacity/)
  await assert.rejects(f.claim(grant.grantID, { kind: "publish", conversationID: "ses_other", messageID: "pub", contentDigest: "a".repeat(64) }))
  await f.claim(grant.grantID, { kind: "publish", conversationID: "ses_target", messageID: "pub", contentDigest: "a".repeat(64) })
  await assert.rejects(f.claim(grant.grantID, { kind: "publish", conversationID: "ses_target", messageID: "pub_other", contentDigest: "a".repeat(64) }), /capacity/)
  await assert.rejects(f.core.reserveEffect(grant.grantID, { kind: "merge", target: "main" }, (await f.store.read())!.revision, signal()))
  const g = await fixture(); await g.authorize({ budgets: { effects: 1, nativeCalls: 0, inboxMessages: 0, publications: 0 } })
  const small = await g.reserve(); const only = await g.claim(small.grantID, { kind: "create" }); g.invoke(only); await g.acknowledge(small.grantID, only.operation.operationID)
  await assert.rejects(g.claim(small.grantID, { kind: "start" }), /capacity/)
})

test("archive/hot ACK tears reconcile metadata only; unsettled or conflicting native evidence cannot retire", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  const lease = await f.claim(grant.grantID, { kind: "create" }); f.invoke(lease)
  await assert.rejects(f.core.settle(grant.grantID, (await f.store.read())!.revision, signal()), /unsettled/)
  f.terminal((await f.store.read())!.child!, "failed")
  f.failAfter(`${f.store.parentKey}/passages/${grant.passage.id}`)
  await assert.rejects(f.core.settle(grant.grantID, (await f.store.read())!.revision, signal()), /ACK lost/)
  assert.equal((await f.store.read())!.settledSequence, 0)
  assert.equal(f.values.has(`${f.store.parentKey}/settled/1`), false)
  const uncommitted = (await f.store.readPassage(grant.passage.id))!
  assert.equal(uncommitted.settlement.outcome, "failed")
  const conflicting = structuredClone(uncommitted)
  conflicting.settlement.evidenceID = "other_evidence"
  await assert.rejects(f.store.archiveChild(conflicting, f.qualifiedCurrent), /request-conflict/)
  assert(same(await f.store.readPassage(grant.passage.id), uncommitted))
  await assert.rejects(f.claim(grant.grantID, { kind: "inbox-read", conversationID: "ses_watched", messageIDs: [] }))
  const archive = await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
  assert.equal((await f.store.read())!.settledSequence, 1)
  assert.equal(f.effects(), 1)
  assert(same(await f.store.readPassage(grant.passage.id), archive))
  await assert.rejects(f.core.settle(grant.grantID, (await f.store.read())!.revision, signal()))
  const g = await fixture(); await g.authorize(); const pending = await g.reserve()
  const effect = await g.claim(pending.grantID, { kind: "create" }); g.invoke(effect); await g.acknowledge(pending.grantID, effect.operation.operationID)
  g.terminal((await g.store.read())!.child!, "failed")
  g.settlements.get(pending.grantID)!.effects[0].evidenceID = "different_native_evidence"
  await assert.rejects(g.core.settle(pending.grantID, (await g.store.read())!.revision, signal()), /request-conflict/)
  assert.equal((await g.store.read())!.settledSequence, 0)
})

test("torn parent denial immediately blocks old/native effects and reconciles only its original signed decision", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  const lease = await f.claim(grant.grantID, { kind: "create" })
  const denial = await f.signed({ action: "pause" }); f.humanReservations.add(authorityDigest(denial))
  f.failAfter(`${f.store.parentKey}/parents/2`)
  await assert.rejects(f.core.authorize(denial, signal()), /ACK lost/)
  assert.equal((await f.store.read())!.parent.body.action, "authorize") // hot tear, not execution permission
  assert.throws(() => f.invoke(lease), /policy-unqualified/)
  await assert.rejects(f.claim(grant.grantID, { kind: "inbox-read", conversationID: "ses_watched", messageIDs: [] }), /authorization-blocked/)
  await assert.rejects(f.authorize({ action: "revoke" }), /request-conflict/)
  f.setHuman(false)
  await assert.rejects(f.core.authorize(denial, signal()))
  f.setHuman(true)
  await f.core.authorize(denial, signal())
  assert.equal((await f.store.read())!.parent.body.action, "pause")
  assert.throws(() => f.invoke(lease), /authorization-blocked/)
  assert.equal(f.effects(), 0)
})

test("torn denial parks ACK/settlement mutations until its exact CAS reconciles, retaining native no-effect evidence", async () => {
  for (const action of ["pause", "revoke"] as const) {
    const f = await fixture(); await f.authorize(); const grant = await f.reserve()
    const lease = await f.claim(grant.grantID, { kind: "create" }), before = (await f.store.read())!
    const receipt: RecurrenceEffectReceipt = { operationID: lease.operation.operationID, outcome: "rejected-before-effect", evidenceID: "native_never_entered" }
    f.receipts.set(receipt.operationID, receipt); f.terminal(before.child!, "rejected-before-effect")
    const denial = await f.signed({ action }); f.humanReservations.add(authorityDigest(denial))
    f.failAfter(`${f.store.parentKey}/parents/2`)
    await assert.rejects(f.core.authorize(denial, signal()), /ACK lost/)
    await assert.rejects(f.acknowledge(grant.grantID, receipt.operationID), /authorization-blocked/)
    await assert.rejects(f.core.settle(grant.grantID, before.revision, signal()), /authorization-blocked/)
    assert(same(await f.store.read(), before))
    assert.equal(f.receipts.get(receipt.operationID)!.evidenceID, "native_never_entered")
    await f.core.authorize(denial, signal()) // original signed revision still applies
    await f.acknowledge(grant.grantID, receipt.operationID)
    await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
    assert.equal((await f.store.read())!.parent.body.action, action)
    assert.equal((await f.store.read())!.settledSequence, 1)
    assert.equal((await f.store.readPassage(grant.passage.id))!.settlement.outcome, "rejected-before-effect")
    assert.throws(() => f.invoke(lease))
    assert.equal(f.effects(), 0)
  }
})

test("effect fences consume before trusted callbacks; failed and reentrant approvals remain parked", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  const lease = await f.claim(grant.grantID, { kind: "create" }), original = f.adapter.assertEffectCurrent
  let reentries = 0
  f.adapter.assertEffectCurrent = (store, child, operation) => {
    assert.throws(() => lease.assertCurrent(), /authorization-blocked/); reentries++
    return original(store, child, operation)
  }
  f.invoke(lease); assert.equal(reentries, 1); assert.equal(f.effects(), 1)
  const g = await fixture(); await g.authorize(); const child = await g.reserve()
  const prepared = await g.claim(child.grantID, { kind: "create" })
  g.setManaged(false); assert.throws(() => prepared.assertCurrent())
  g.setManaged(true); assert.throws(() => prepared.assertCurrent(), /authorization-blocked/)
  assert.equal(g.effects(), 0)
})

test("logical invocation/message identities cannot be renewed with changed descriptors; stored scope damage fails closed", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  for (const kind of ["create", "start"] as const) {
    const lease = await f.claim(grant.grantID, { kind }); f.invoke(lease); await f.acknowledge(grant.grantID, lease.operation.operationID)
  }
  const native: RecurrenceEffect = { kind: "native-call", taskKey: "task", generation: 1, parentSessionID: grant.coordinatorSessionID,
    parentMessageID: grant.messageID, toolCallID: "call", directory: root.directory, mode: "native", execution }
  await f.claim(grant.grantID, native)
  await assert.rejects(f.claim(grant.grantID, { ...native, targetSessionID: "other_session" }), /request-conflict/)
  await f.claim(grant.grantID, { kind: "publish", conversationID: "ses_target", messageID: "pub", contentDigest: "a".repeat(64) })
  await assert.rejects(f.claim(grant.grantID, { kind: "publish", conversationID: "ses_target", messageID: "pub", contentDigest: "b".repeat(64) }), /request-conflict/)
  const damaged = structuredClone(f.values.get(f.store.key)) as unknown as RecurrenceAuthorityDocument
  const publication = damaged.child!.effects.at(-1)!
  assert.equal(publication.effect.kind, "publish")
  if (publication.effect.kind === "publish") publication.effect.conversationID = "ses_not_authorized"
  publication.operationID = recurrenceEffectID(damaged.child!.grant, publication.effect)
  f.values.set(f.store.key, damaged as unknown as MissionJsonValue)
  await assert.rejects(f.store.read(), /authorization-blocked/)
})

test("large valid ledgers exceed ordinary signing-byte limits without stranding effect or terminal evidence", async () => {
  const f = await fixture()
  const roots = Array.from({ length: 6 }, (_, index) => ({ ...root, directory: `/owned/${index}/${"x".repeat(3900)}`,
    family: `family_${index}`, checkout: `/checkout_${index}` }))
  const big: RecurrenceConfig = { ...config, roots, consigne: "x".repeat(16_384) }
  const source = (await f.source.read(scope.scheduleID))!
  await f.source.configure(source.id, source.revision, big, f.qualifiedCurrent)
  f.setSigners([{ ...f.signer, roots }])
  await f.authorize({ config: big, scheduleRevision: 1 })
  const grant = await f.reserve()
  assert(Buffer.byteLength(canonicalAuthority(await f.store.read(), 256 * 1024)) > 128 * 1024)
  const lease = await f.claim(grant.grantID, { kind: "create" }); f.invoke(lease)
  await f.acknowledge(grant.grantID, lease.operation.operationID)
  f.terminal((await f.store.read())!.child!, "failed")
  await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
  assert.equal((await f.store.read())!.settledSequence, 1)
  assert.equal((await f.store.readPassage(grant.passage.id))!.settlement.outcome, "failed")
})

test("receipt and denial/retirement bookkeeping consume reserved headroom without raising the 256-KiB limit", async () => {
  const roots = Array.from({ length: 12 }, (_, index) => ({ ...root, directory: `/owned/${index}/${"x".repeat(3150)}`,
    family: `family_${index}`, checkout: `/checkout_${index}` }))
  async function sizedFixture(length: number) {
    const f = await fixture(), big = { ...config, roots, consigne: "x".repeat(length) }
    const source = (await f.source.read(scope.scheduleID))!
    await f.source.configure(source.id, source.revision, big, f.qualifiedCurrent)
    f.setSigners([{ ...f.signer, roots }])
    await f.authorize({ config: big, scheduleRevision: 1, budgets: { effects: 8, nativeCalls: 0, inboxMessages: 32, publications: 0 } })
    const grant = await f.reserve()
    for (const kind of ["create", "start"] as const) {
      const lease = await f.claim(grant.grantID, { kind }); f.invoke(lease); await f.acknowledge(grant.grantID, lease.operation.operationID)
    }
    return { f, grant }
  }
  const baseline = await sizedFixture(16_000), proposed = (await baseline.f.store.read())!
  const effect: RecurrenceEffect = { kind: "inbox-read", conversationID: "ses_watched",
    messageIDs: Array.from({ length: 32 }, (_, index) => `msg_${index}_${"x".repeat(230)}`) }
  proposed.revision++; proposed.child!.effects.push({ operationID: recurrenceEffectID(baseline.grant, effect), effect, receipt: null })
  const target = 196_596, bytes = Buffer.byteLength(canonicalAuthority(proposed, RECURRENCE_AUTHORITY_MAX_BYTES))
  const odd = (target - bytes) % 2
  if (odd) effect.messageIDs[31] += "x"
  const length = 16_000 + (target - bytes - odd) / 2
  assert(length > 0 && length <= 16_384)
  const { f, grant } = await sizedFixture(length)
  const lease = await f.claim(grant.grantID, effect)
  assert.equal(Buffer.byteLength(canonicalAuthority(await f.store.read(), RECURRENCE_AUTHORITY_MAX_BYTES)), target)
  f.invoke(lease)
  const receipt = f.receipts.get(lease.operation.operationID)!, materialized = (await f.store.read())!
  materialized.revision++; materialized.child!.effects.at(-1)!.receipt = receipt
  const ackTarget = 196_938, receiptLength = receipt.evidenceID.length + ackTarget
    - Buffer.byteLength(canonicalAuthority(materialized, RECURRENCE_AUTHORITY_MAX_BYTES))
  assert(receiptLength > 0 && receiptLength <= 240)
  receipt.evidenceID = "e".repeat(receiptLength)
  await f.acknowledge(grant.grantID, lease.operation.operationID)
  const acknowledged = (await f.store.read())!, size = Buffer.byteLength(canonicalAuthority(acknowledged, RECURRENCE_AUTHORITY_MAX_BYTES))
  assert.equal(size, ackTarget)
  assert(size > RECURRENCE_AUTHORITY_MAX_BYTES - 64 * 1024 && size < RECURRENCE_AUTHORITY_MAX_BYTES)
  await assert.rejects(f.claim(grant.grantID, { kind: "coordinator-message", messageID: "msg_extra", contentDigest: "a".repeat(64) }), /capacity/)
  assert(same(await f.store.read(), acknowledged))
  await f.authorize({ action: "pause", budgets: acknowledged.parent.body.budgets })
  f.terminal((await f.store.read())!.child!)
  await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
  assert.equal((await f.store.read())!.settledSequence, 1)
  assert.equal((await f.store.readPassage(grant.passage.id))!.settlement.outcome, "completed")
  assert.equal(RECURRENCE_AUTHORITY_MAX_BYTES, 256 * 1024)
})

test("committed archive digest rejects schema-valid outcome/evidence corruption on reads and publications", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  const lease = await f.claim(grant.grantID, { kind: "create" }); f.invoke(lease)
  f.terminal((await f.store.read())!.child!, "failed")
  const archive = await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
  const key = `${f.store.parentKey}/passages/${grant.passage.id}`, index = `${f.store.parentKey}/settled/1`, committed = f.values.get(index)
  for (const field of ["outcome", "evidenceID"] as const) {
    const corrupted = structuredClone(archive)
    if (field === "outcome") corrupted.settlement.outcome = "completed"
    else corrupted.settlement.evidenceID = "changed_native_evidence"
    f.values.set(key, corrupted as unknown as MissionJsonValue)
    await assert.rejects(f.store.readPassage(grant.passage.id), /storage-invalid/)
    await assert.rejects(f.store.archiveChild(corrupted, f.qualifiedCurrent), /storage-invalid/)
    assert.equal(f.values.get(index), committed)
  }
  f.values.set(key, archive as unknown as MissionJsonValue)
  assert(same(await f.store.readPassage(grant.passage.id), archive))
  f.values.delete(key)
  await assert.rejects(f.store.read(), /storage-invalid/, "a committed digest cannot conceal a deleted passage")
  f.values.set(key, archive as unknown as MissionJsonValue)
  f.values.delete(index)
  await assert.rejects(f.store.read(), /storage-invalid/, "deleting the index cannot conceal the committed sequence")
})

test("accepted passage is recorded while its native child is live; settlement archives before finish", async () => {
  const f = await fixture(); await f.authorize()
  const grant = await f.reserve(), pending = (await f.source.read(scope.scheduleID))!
  const effect = await f.claim(grant.grantID, { kind: "create" }); f.invoke(effect)
  const admitted = await f.source.recordAdmission(scope.scheduleID, { kind: "accepted", passageID: grant.passage.id,
    messageID: grant.messageID, missionID: grant.missionID, conversationID: grant.coordinatorSessionID }, pending.createdAt + 1, f.qualifiedCurrent)
  assert.equal((await f.store.read())!.child?.grant.grantID, grant.grantID)
  assert.deepEqual(admitted.pending?.admission, { kind: "accepted", passageID: grant.passage.id,
    messageID: grant.messageID, missionID: grant.missionID, conversationID: grant.coordinatorSessionID })
  await assert.rejects(f.source.finish(scope.scheduleID, { passageID: grant.passage.id, messageID: "wrong_message",
    missionID: grant.missionID, conversationID: grant.coordinatorSessionID, outcome: "completed",
    artifactMessageIDs: [], cursors: [] }, pending.createdAt + 2, f.qualifiedCurrent), /passage conflict/)
  f.terminal((await f.store.read())!.child!)
  const archive = await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
  assert.equal(archive.child.grant.passage.id, pending.pending!.passage.id)
  assert.equal((await f.store.read())!.settledSequence, 1)
  const finished = await f.source.finish(scope.scheduleID, { passageID: grant.passage.id, messageID: grant.messageID,
    missionID: grant.missionID, conversationID: grant.coordinatorSessionID, outcome: "completed",
    artifactMessageIDs: [], cursors: [] }, pending.createdAt + 2, f.qualifiedCurrent)
  assert.equal(finished.pending, null)
  assert.equal(finished.settledCount, 1)
})

test("committed Pause permits a late applied receipt and child terminal with a fresh evidence signal", async () => {
  const f = await fixture(); await f.authorize(); const grant = await f.reserve()
  const lease = await f.claim(grant.grantID, { kind: "create" }); f.invoke(lease)
  const due = new AbortController()
  due.abort("dispatch was cancelled by Pause")
  await f.authorize({ action: "pause" })
  await assert.rejects(f.claim(grant.grantID, { kind: "start" }), /authorization-blocked/)
  // A cancelled dispatch signal cannot become the receipt's evidence lifetime.
  await assert.rejects(f.core.acknowledgeEffect(grant.grantID, lease.operation.operationID,
    (await f.store.read())!.revision, due.signal))
  await f.acknowledge(grant.grantID, lease.operation.operationID)
  f.terminal((await f.store.read())!.child!)
  const archive = await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
  assert.equal(archive.settlement.outcome, "completed")
  assert.equal(archive.settlement.effects[0]?.outcome, "applied")
  assert.equal((await f.store.read())!.parent.body.action, "pause")
})

test("crash after authority archive parks original pending until exact metadata finish; no replay or next passage", async () => {
  const f = await fixture(); await f.authorize()
  const grant = await f.reserve(), effect = await f.claim(grant.grantID, { kind: "create" })
  f.invoke(effect)
  const pending = (await f.source.read(scope.scheduleID))!
  await f.source.recordAdmission(scope.scheduleID, { kind: "accepted", passageID: grant.passage.id,
    messageID: grant.messageID, missionID: grant.missionID, conversationID: grant.coordinatorSessionID },
  pending.createdAt + 1, f.qualifiedCurrent)
  f.terminal((await f.store.read())!.child!)
  const archived = await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
  const effects = f.effects()
  assert.equal((await f.store.read())!.child, null)
  assert.equal((await f.source.read(scope.scheduleID))!.pending?.passage.id, grant.passage.id)
  assert.equal((await f.store.readPassage(grant.passage.id))?.settlement.evidenceID, archived.settlement.evidenceID)
  await assert.rejects(f.reserve(), /cannot trigger/)
  await assert.rejects(f.claim(grant.grantID, { kind: "start" }))
  assert.equal(f.effects(), effects, "no native operation is replayed after the crash boundary")
  const finished = await f.source.finish(scope.scheduleID, { passageID: grant.passage.id, messageID: grant.messageID,
    missionID: grant.missionID, conversationID: grant.coordinatorSessionID, outcome: "completed",
    artifactMessageIDs: [], cursors: [] }, pending.createdAt + 2, f.qualifiedCurrent)
  assert.equal(finished.pending, null)
  assert.equal((await f.reserve()).sequence, 2, "a new sequence needs explicit old metadata settlement")
  assert.equal(f.effects(), effects)
})

test("all three applied passage effects archive before the next passage can be reserved", async () => {
  const f = await fixture(); await f.authorize()
  const grant = await f.reserve()
  for (const effect of [{ kind: "create" } as const, { kind: "start" } as const,
    { kind: "coordinator-message", messageID: grant.messageID, contentDigest: authorityDigest(config.consigne) } as const]) {
    const lease = await f.claim(grant.grantID, effect)
    f.invoke(lease)
    await f.acknowledge(grant.grantID, lease.operation.operationID)
  }
  const pending = (await f.source.read(scope.scheduleID))!
  await f.source.recordAdmission(scope.scheduleID, { kind: "accepted", passageID: grant.passage.id,
    messageID: grant.messageID, missionID: grant.missionID, conversationID: grant.coordinatorSessionID },
  pending.pending!.passage.createdAt + 1, f.qualifiedCurrent)
  f.terminal((await f.store.read())!.child!)
  const archived = await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
  assert.deepEqual(archived.settlement.effects.map(effect => effect.outcome), ["applied", "applied", "applied"])
  await assert.rejects(f.reserve(), /cannot trigger/, "an archive alone must not allow the next passage")
  await f.source.finish(scope.scheduleID, { passageID: grant.passage.id, messageID: grant.messageID,
    missionID: grant.missionID, conversationID: grant.coordinatorSessionID, outcome: "completed",
    artifactMessageIDs: [], cursors: [] }, pending.pending!.passage.createdAt + 2, f.qualifiedCurrent)
  assert.equal((await f.reserve()).sequence, 2)
})

test("1,025 passages retain permanent replay evidence with constant hot state and untouched ordinary authority/user bytes", async () => {
  const f = await fixture(); await f.authorize()
  const ordinaryKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/project/${f.store.projectToken}`
  const ordinary = { grants: Array.from({ length: 256 }, (_, i) => `grant_${i}`), receipts: Array.from({ length: 1000 }, (_, i) => `receipt_${i}`) }
  f.values.set(ordinaryKey, ordinary)
  f.values.set("codenomad-missions/v1/do-not-touch", { original: true })
  const original = canonicalAuthority(ordinary), sizes: number[] = []
  let firstPassage = "", firstSource: Awaited<ReturnType<typeof f.source.read>>
  for (let index = 0; index < 1025; index++) {
    const grant = await f.reserve()
    if (!index) { firstPassage = grant.passage.id; firstSource = await f.source.read(scope.scheduleID) }
    const lease = await f.claim(grant.grantID, { kind: "create" }); f.invoke(lease)
    f.terminal((await f.store.read())!.child!, "failed")
    await f.core.settle(grant.grantID, (await f.store.read())!.revision, signal())
    await f.finishSource("failed")
    const hot = (await f.store.read())!
    assert.equal(hot.child, null); assert.equal(hot.settledSequence, index + 1)
    sizes.push(Buffer.byteLength(canonicalAuthority(hot)))
  }
  assert(Math.max(...sizes) - Math.min(...sizes) < 32)
  assert.equal((await f.store.readPassage(firstPassage))!.child.grant.sequence, 1)
  await assert.rejects(f.core.reservePassage(firstSource!, (await f.store.read())!.revision, signal()))
  const rewritten = structuredClone(firstSource!)
  rewritten.settledCount = 1025
  await assert.rejects(f.core.reservePassage(rewritten, (await f.store.read())!.revision, signal()))
  assert.equal(canonicalAuthority(f.values.get(ordinaryKey)), original)
  assert.deepEqual(f.values.get("codenomad-missions/v1/do-not-touch"), { original: true })
  assert.equal(f.writes.filter(key => key === ordinaryKey).length, 0)
  assert.equal(f.effects(), 1025)
})
