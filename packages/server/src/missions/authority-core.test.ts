import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import test from "node:test"
import { MissionJournal, type MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { NativeMissionAuthority, type NativeAuthorityAdapter, type AuthorityMissionObservation, type AuthorityEffectIntent } from "./authority-core"
import { NativeMissionAuthorityStore, type AuthorityCapacity } from "./authority-store"
import {
  authoritySigningBytes, authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY, MissionAuthorityError,
  type AuthorityIntent, type SignedAuthorityIntent, type ProvisionedAuthoritySigner, type AuthoritySignerSnapshot,
} from "./authority-protocol"
import { admitWithMissionAuthority } from "./authority-admission"
import { missionAuthorityHandlers, rejectUnsignedMissionMutators } from "./authority-rpc"
import { controlOperationID } from "./receipt-identity"

// Native storage semantics: portable JSON copies, async get/set/scan; no invented
// transaction/CAS API. Faults can occur both before and after set publication.
class NativeStyleStorage implements MissionStorage {
  readonly values = new Map<string, MissionJsonValue>()
  getFault = false
  setFault: "before" | "after" | undefined
  async get(key: string) {
    if (this.getFault) throw new Error("private storage secret")
    const value = this.values.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }
  async set(key: string, value: MissionJsonValue) {
    if (this.setFault === "before") throw new Error("private storage secret")
    this.values.set(key, JSON.parse(JSON.stringify(value)))
    if (this.setFault === "after") throw new Error("private storage secret")
  }
  async scan({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
    const page = keys.slice(0, limit)
    return { entries: page.map(key => ({ key, value: structuredClone(this.values.get(key)!) })),
      ...(keys.length > limit ? { next: page[page.length - 1] } : {}) }
  }
}
const signal = () => new AbortController().signal
const rejects = (code: MissionAuthorityError["code"]) => (error: unknown) => {
  assert.ok(error instanceof MissionAuthorityError)
  assert.equal(error.code, code)
  assert.ok(!error.message.includes("secret"))
  return true
}
async function fixture(options: { storage?: NativeStyleStorage; projectID?: string; profileID?: string; missionID?: string; provisioningGeneration?: string; capacity?: Partial<AuthorityCapacity> } = {}) {
  const storage = options.storage ?? new NativeStyleStorage()
  const projectID = options.projectID ?? `project-${randomUUID()}`
  const store = new NativeMissionAuthorityStore(storage, projectID, `/owned/${projectID}`, options.capacity)
  const namespace = await store.initialize()
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const scope = { authorityID: "host-authority", keyID: "key-one", profileID: options.profileID ?? "profile-one",
    executionHost: "windows:host-one", namespace, projectID, projectCanonical: store.projectCanonical,
    roots: [{ mode: "git" as const, directory: store.projectCanonical, family: "family-one", checkout: "checkout-one" }],
  }
  const missionID = options.missionID ?? "mission-one"
  let signers: readonly ProvisionedAuthoritySigner[] = [{ ...scope, publicKey, provisioningGeneration: options.provisioningGeneration ?? "generation-one", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }]
  let mission: AuthorityMissionObservation | undefined = { missionID, coordinatorSessionID: "session-coordinator",
    revision: 1, status: "active", runState: "prepared", controlPending: false, roots: scope.roots }
  let observationsFault = false
  let journalFull = false
  let effects = 0
  let active = true
  let signerHook: (() => Promise<void>) | undefined
  let observationHook: (() => void) | undefined
  let fenceHook: ((signer: AuthoritySignerSnapshot) => unknown) | undefined
  const assertSignerCurrent = (signer: AuthoritySignerSnapshot): true => {
    if (fenceHook) return fenceHook(signer) as true // Deliberately invalid runtime integration fixture.
    const current = signers.find(value => value.authorityID === signer.authorityID && value.keyID === signer.keyID
      && value.profileID === signer.profileID && value.executionHost === signer.executionHost && value.namespace === signer.namespace
      && value.projectID === signer.projectID && value.projectCanonical === signer.projectCanonical)
    if (!current || current.qualification !== "qualified" || current.policy !== signer.policy) throw new MissionAuthorityError("policy-unqualified")
    if (authoritySignerDigest(current.publicKey) !== authoritySignerDigest(signer.publicKey)
      || current.provisioningGeneration !== signer.provisioningGeneration
      || canonicalAuthority(current.roots) !== canonicalAuthority(signer.roots)) throw new MissionAuthorityError("untrusted-signer")
    return true
  }
  const authority = new NativeMissionAuthority(store, {
    assertActive: () => { if (!active) throw new MissionAuthorityError("authorization-blocked") },
    readSigners: async () => { await signerHook?.(); return signers },
    assertSignerCurrent,
    observeMission: async id => {
      observationHook?.()
      if (observationsFault) throw new Error("private observation secret")
      return mission?.missionID === id ? structuredClone(mission) : undefined
    },
    assertJournalCapacity: async () => { if (journalFull) throw new MissionAuthorityError("capacity") },
  })
  const intent = (method: AuthorityIntent["method"], overrides: Record<string, unknown> = {}): AuthorityIntent => ({
    ...scope, version: 1, policy: MISSION_AUTHORITY_POLICY, missionID, coordinatorSessionID: "session-coordinator",
    requestID: `request-${randomUUID()}`, expectedRevision: mission?.revision ?? 0,
    epoch: method === "adopt" ? 1 : method === "create" ? 0 : 1,
    method, payload: method === "lifecycle" ? { action: "start" }
      : method === "create" ? { prepared: true, objective: "Bounded work", template: "custom" }
      : method === "update" ? { objective: "New objective" }
      : method === "delete" ? { deleteManagedSessions: false }
      : method === "recover" ? { target: "coordinator" } : {}, ...overrides,
  }) as AuthorityIntent
  const envelope = (body: AuthorityIntent): SignedAuthorityIntent => ({ body: structuredClone(body), signature: sign(null, authoritySigningBytes(body), privateKey).toString("base64") })
  const adapter = { apply: async (body: AuthorityEffectIntent) => {
    effects++
    if (body.method === "lifecycle" && mission) {
      mission.runState = body.payload.action === "start" ? "running" : body.payload.action === "pause" ? "paused" : "stopped"
      mission.revision++
      mission.control = { ...body, action: body.payload.action, id: controlOperationID(body.missionID, body.requestID),
        targets: [{ sessionID: body.coordinatorSessionID, location: { directory: body.projectCanonical } }], pending: [], completedRevision: mission.revision }
    }
    if (body.method === "create") mission = { missionID: body.missionID, coordinatorSessionID: body.coordinatorSessionID,
      revision: 1, status: "active", runState: "prepared", roots: body.roots, controlPending: false }
    return { missionID: body.missionID, revision: mission?.revision ?? 1,
      ...(body.method === "lifecycle" ? { operationID: controlOperationID(body.missionID, body.requestID) } : {}) }
  } }
  const execute = (body: AuthorityIntent) => authority.execute(envelope(body), adapter, signal())
  const adopt = () => execute(intent("adopt"))
  const start = () => execute(intent("lifecycle"))
  const admission = (epoch = 1) => ({ ...scope, missionID, coordinatorSessionID: "session-coordinator", epoch, root: scope.roots[0] })
  return { storage, store, authority, scope, publicKey, privateKey, intent, envelope, adapter, execute, adopt, start, admission,
    effects: () => effects, mission: () => mission,
    setMission: (value: AuthorityMissionObservation | undefined) => { mission = value },
    setSigners: (value: readonly ProvisionedAuthoritySigner[]) => { signers = value }, signers: () => signers,
    setObservationFault: () => { observationsFault = true }, setJournalFull: () => { journalFull = true },
    dispose: () => { active = false }, setSignerHook: (hook?: () => Promise<void>) => { signerHook = hook }, assertSignerCurrent,
    setObservationHook: (hook?: () => void) => { observationHook = hook },
    setFenceHook: (hook?: (signer: AuthoritySignerSnapshot) => unknown) => { fenceHook = hook },
  }
}

test("canonical signed protocol is bounded, deterministic, rejects exotic/accessor input", () => {
  assert.equal(canonicalAuthority({ z: [1, 2, 3], a: "✓" }), '{"a":"✓","z":[1,2,3]}')
  assert.throws(() => canonicalAuthority({ a: undefined }), rejects("invalid-intent"))
  assert.throws(() => canonicalAuthority(new Date()), rejects("invalid-intent"))
  assert.throws(() => canonicalAuthority([, 1]), rejects("invalid-intent"))
  assert.throws(() => canonicalAuthority({ get secret() { throw new Error("must not execute") } }), rejects("invalid-intent"))
  assert.throws(() => canonicalAuthority({ a: "x".repeat(200) }, 100), rejects("capacity"))
  const cyclic: unknown[] = []; cyclic.push(cyclic)
  assert.throws(() => canonicalAuthority(cyclic), rejects("invalid-intent"))
})

test("signature and every trusted full binding are required; keys never come from RPC", async () => {
  const f = await fixture()
  const original = f.intent("adopt")
  const bad = f.envelope(original)
  bad.body.payload = { objective: "forged" } as never
  await assert.rejects(f.authority.execute(bad, f.adapter, signal()), rejects("invalid-intent"))
  for (const [field, value] of Object.entries({ authorityID: "other", keyID: "other", profileID: "other", executionHost: "wsl:other",
    namespace: randomUUID(), projectID: "other", projectCanonical: "/other", roots: [{ mode: "directory-only", directory: "/other" }],
    missionID: "other-mission", coordinatorSessionID: "other-session", epoch: 2, expectedRevision: 2 })) {
    await assert.rejects(f.execute(f.intent("adopt", { [field]: value })), MissionAuthorityError, field)
  }
  const forged = f.envelope(original)
  forged.signature = sign(null, authoritySigningBytes(original), generateKeyPairSync("ed25519").privateKey).toString("base64")
  await assert.rejects(f.authority.execute(forged, f.adapter, signal()), rejects("untrusted-signer"))
  await assert.rejects(f.authority.execute({ ...f.envelope(original), publicKey: f.publicKey.export({ type: "spki", format: "pem" }) }, f.adapter, signal()), rejects("invalid-intent"))
  await assert.rejects(f.execute(f.intent("invoke" as never)), rejects("invalid-intent"))
  f.setSigners([])
  await assert.rejects(f.execute(original), rejects("untrusted-signer"))
  assert.equal(f.effects(), 0)
  assert.equal((await f.store.read()).receipts.length, 0)
})

test("adoption is metadata-only; exact retries return CURRENT revoked/new-epoch grant", async () => {
  const f = await fixture()
  const adoption = f.intent("adopt")
  const result = await f.execute(adoption)
  assert.equal(result.grant?.state, "active")
  assert.equal(result.grant?.sendsEnabled, false)
  assert.equal(f.effects(), 0)
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("authorization-blocked"))
  await f.start()
  await f.authority.assertAdmission(f.admission())
  await f.execute(f.intent("revoke"))
  assert.equal((await f.authority.state("mission-one")).continuity, "revoked")
  const replay = await f.execute(adoption)
  assert.equal(replay.grant?.state, "revoked")
  assert.equal(replay.grant?.sendsEnabled, false)
  await f.execute(f.intent("adopt", { epoch: 2 }))
  assert.equal((await f.execute(adoption)).grant?.epoch, 2)
  await assert.rejects(f.authority.assertAdmission(f.admission()), MissionAuthorityError)
  assert.equal(f.effects(), 1)
  await assert.rejects(f.execute({ ...adoption, payload: { forged: true } } as never), rejects("invalid-intent"))
  await assert.rejects(f.execute({ ...adoption, expectedRevision: adoption.expectedRevision + 1 }), rejects("request-conflict"))
})

test("two authority incarnations serialize CAS grants and immutable request digests", async () => {
  const f = await fixture()
  const second = new NativeMissionAuthority(new NativeMissionAuthorityStore(f.storage, f.scope.projectID, f.scope.projectCanonical), {
    assertActive: () => {},
    readSigners: async () => f.signers(), assertSignerCurrent: f.assertSignerCurrent,
    observeMission: async () => f.mission(), assertJournalCapacity: async () => {},
  })
  const body = f.intent("adopt")
  const results = await Promise.all([f.execute(body), second.execute(f.envelope(body), f.adapter, signal())])
  assert.equal(results[0].grant?.epoch, 1)
  assert.equal(results[1].grant?.epoch, 1)
  assert.equal((await f.store.read()).receipts.length, 1)
  const competing = await Promise.allSettled([f.execute(f.intent("adopt", { epoch: 2 })),
    second.execute(f.envelope(f.intent("adopt", { epoch: 2 })), f.adapter, signal())])
  assert.equal(competing.filter(result => result.status === "fulfilled").length, 1)
  assert.equal(competing.filter(result => result.status === "rejected").length, 1)
})

test("revoke during preparation blocks send; host checks and both native checks are mandatory", async () => {
  const f = await fixture(); await f.adopt(); await f.start()
  let prepares = 0; let sends = 0; let hostReads = 0; let gates = 0
  await assert.rejects(admitWithMissionAuthority({ authority: f.authority, binding: f.admission(), signal: signal(),
    assertHostGrant: async () => { hostReads++ }, withHostGate: async run => { gates++; return run() },
    prepare: async () => { prepares++; await f.execute(f.intent("revoke")); return "fresh environment" },
    send: async () => { sends++; return true },
  }), rejects("authorization-blocked"))
  assert.deepEqual({ prepares, sends, hostReads, gates }, { prepares: 1, sends: 0, hostReads: 1, gates: 1 })
  await assert.rejects(admitWithMissionAuthority({ authority: f.authority, binding: f.admission(), signal: signal(),
    assertHostGrant: async () => {}, withHostGate: async run => run(), prepare: async () => { prepares++; return "unused" }, send: async () => true,
  }), rejects("authorization-blocked"))
  assert.equal(prepares, 1)
})

test("pending Play cannot be replayed or restore a revoked epoch after native completion", async () => {
  const f = await fixture(); await f.adopt()
  let entered!: () => void; let release!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const play = f.intent("lifecycle")
  let calls = 0
  const effects = { apply: async (body: AuthorityEffectIntent) => { calls++; entered(); await held; return f.adapter.apply(body) } }
  const executing = f.authority.execute(f.envelope(play), effects, signal())
  await enteredPromise
  const pendingRetry = await f.authority.execute(f.envelope(play), effects, signal())
  assert.equal(pendingRetry.receipt.completion, undefined)
  assert.equal(calls, 1)
  await f.execute(f.intent("revoke"))
  release()
  const completion = await executing
  assert.equal(completion.grant?.state, "revoked")
  assert.equal(completion.grant?.sendsEnabled, false)
  assert.equal((await f.execute(play)).grant?.state, "revoked")
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("authorization-blocked"))
})

test("Stop/delete publish terminal denial before effects; old intents cannot resurrect it", async () => {
  for (const method of ["lifecycle", "delete"] as const) {
    const f = await fixture(); const adoption = f.intent("adopt"); await f.execute(adoption); await f.start()
    const stopping = f.intent(method, method === "lifecycle" ? { payload: { action: "stop" } } : {})
    await assert.rejects(f.authority.execute(f.envelope(stopping), { apply: async () => {
      const doc = await f.store.read()
      assert.equal(doc.grants[0].state, "revoked")
      assert.equal(doc.terminals.length, 1)
      throw new Error("private native secret")
    } }, signal()), rejects("effect-unavailable"))
    assert.equal((await f.execute(adoption)).grant?.state, "revoked")
    await assert.rejects(f.execute(f.intent("adopt", { epoch: 2 })), rejects("authorization-blocked"))
    const retry = await f.execute(stopping)
    assert.equal(retry.receipt.completion, undefined)
    assert.equal(f.effects(), 1)
  }
})

test("authority documents have no migration metadata or legacy import API", async () => {
  const f = await fixture()
  const before = await f.store.read()
  assert.equal("migrations" in before, false)
  assert.equal("migrations" in f.store.capacity, false)
  assert.equal("migrateLegacy" in f.authority, false)
  await assert.rejects(f.store.transaction(async doc => Object.assign(doc, {
    migrations: [{ missionID: "legacy-one", revision: 7, continuity: "needs-authorization" }],
  })), rejects("storage-invalid"))
  assert.deepEqual(await f.store.read(), before)
  assert.equal(f.effects(), 0)
  assert.equal((await f.authority.state("legacy-one")).continuity, "needs-authorization")
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("authorization-blocked"))
})

test("capacity reservations reject before business effects, including journal and byte quotas", async () => {
  for (const setup of ["receipts", "bytes", "journal"] as const) {
    const f = await fixture({ capacity: setup === "receipts" ? { receipts: 2 }
      : setup === "bytes" ? { bytes: 3000, resultBytes: 1000 } : {} })
    if (setup === "receipts") await f.adopt()
    if (setup === "journal") f.setJournalFull()
    const body = setup === "bytes" ? f.intent("update", { epoch: 0, payload: { objective: "x".repeat(4000) } })
      : setup === "receipts" ? f.intent("lifecycle") : f.intent("adopt")
    await assert.rejects(f.execute(body), rejects("capacity"))
    assert.equal(f.effects(), 0)
    assert.equal((await f.store.read()).receipts.length, setup === "receipts" ? 1 : 0)
  }
})

test("ordinary receipt/byte exhaustion cannot consume an enabled grant's denial capacity", async () => {
  for (const capacity of [{ receipts: 4 }, { bytes: 12000, resultBytes: 512 }]) {
    for (const method of ["revoke", "stop"] as const) {
      const f = await fixture({ capacity })
      await f.adopt(); await f.start()
      let exhausted = false
      for (let index = 0; index < 20; index++) {
        try { await f.execute(f.intent("update", { payload: { objective: "x".repeat(1500) } })) }
        catch (error) { assert.ok(error instanceof MissionAuthorityError && error.code === "capacity"); exhausted = true; break }
      }
      assert.ok(exhausted, "ordinary traffic reaches the reserved ceiling")
      await f.authority.assertAdmission(f.admission())
      f.setJournalFull()
      if (method === "revoke") {
        const effects = f.effects()
        await f.execute(f.intent("revoke", { requestID: "✓".repeat(128) }))
        assert.equal(f.effects(), effects, "metadata-only revocation requires no business journal writes")
      } else {
        await assert.rejects(f.authority.execute(f.envelope(f.intent("lifecycle", { payload: { action: "stop" } })), {
          apply: async () => { throw new MissionAuthorityError("capacity") },
        }, signal()), rejects("capacity"))
        assert.equal((await f.authority.state("mission-one")).terminal, "stopped")
      }
      const state = await f.authority.state("mission-one")
      assert.equal(state.grant?.state, "revoked")
      assert.equal(state.grant?.sendsEnabled, false)
      await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("authorization-blocked"))
    }
  }
})

test("denial reserves complete escaped receipt metadata and terminal bytes at the schema limits", async () => {
  for (const denial of ["revoke", "stop", "delete"] as const) {
    const f = await fixture({ missionID: "\0".repeat(240), provisioningGeneration: "\0".repeat(240),
      capacity: { bytes: 30000, resultBytes: 2048 } })
    await f.adopt(); await f.start()
    let exhausted = false
    for (let index = 0; index < 40; index++) {
      try { await f.execute(f.intent("update", { payload: { objective: "x".repeat(100) } })) }
      catch (error) { rejects("capacity")(error); exhausted = true; break }
    }
    assert.ok(exhausted, "saturate ordinary bytes including the protected denial reserve")
    await f.authority.assertAdmission(f.admission())
    const body = f.intent(denial === "stop" ? "lifecycle" : denial, {
      requestID: "\0".repeat(128), ...(denial === "stop" ? { payload: { action: "stop" } } : {}),
    })
    await f.execute(body)
    const state = await f.authority.state(body.missionID)
    assert.equal(state.grant?.state, "revoked")
    assert.equal(state.grant?.sendsEnabled, false)
    assert.equal(state.terminal, denial === "revoke" ? null : denial === "stop" ? "stopped" : "deleted")
    assert.ok((await f.store.read()).receipts.find(receipt => receipt.requestID === body.requestID)?.completion)
    await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("authorization-blocked"))
  }
})

test("adoption publication and Play settlement recheck current host qualification and exact key after observations", async () => {
  for (const failure of ["qualification", "key"] as const) {
    const f = await fixture()
    const provisioned = f.signers()[0]
    f.setObservationHook(() => f.setSigners([{ ...provisioned, ...(failure === "qualification"
      ? { qualification: "downgrade-unqualified" as const } : { publicKey: generateKeyPairSync("ed25519").publicKey }) }]))
    await assert.rejects(f.adopt(), rejects(failure === "qualification" ? "policy-unqualified" : "untrusted-signer"))
    assert.equal((await f.store.read()).grants.length, 0)
    assert.equal((await f.store.read()).receipts.length, 0)
  }
  const f = await fixture(); await f.adopt()
  const provisioned = f.signers()[0]
  await assert.rejects(f.authority.execute(f.envelope(f.intent("lifecycle")), {
    apply: async body => {
      const result = await f.adapter.apply(body)
      f.setObservationHook(() => f.setSigners([{ ...provisioned, qualification: "rotation-pending" }]))
      return result
    },
  }, signal()), rejects("policy-unqualified"))
  const doc = await f.store.read()
  assert.equal(doc.grants[0].sendsEnabled, false)
  assert.equal(doc.receipts.at(-1)?.completion, undefined, "a failed publication retains honest pending native effects")
})

test("publication retains the exact signature-verified immutable key and generation, not a later trust read", async () => {
  for (const mode of ["replace", "in-place", "generation"] as const) {
    const f = await fixture()
    const signer = f.signers()[0]
    let reads = 0
    f.setSignerHook(async () => {
      if (++reads !== 3) return
      const publicKey = generateKeyPairSync("ed25519").publicKey
      if (mode === "replace") f.setSigners([{ ...signer, publicKey }])
      else if (mode === "in-place") signer.publicKey = publicKey
      else signer.provisioningGeneration = "replacement-generation"
    })
    await assert.rejects(f.adopt(), rejects("untrusted-signer"), mode)
    assert.equal((await f.store.read()).grants.length, 0)
    assert.equal((await f.store.read()).receipts.length, 0)
  }
  const f = await fixture()
  // Verify runtime frozen scope/key using a non-recursive fixture fence.
  f.setFenceHook(snapshot => {
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.roots) && snapshot.roots.every(Object.isFrozen))
    assert.equal(snapshot.signerDigest, authoritySignerDigest(f.publicKey))
    assert.notEqual(snapshot.publicKey, f.publicKey)
    return true
  })
  await f.adopt()
})

test("synchronous publication fences reject promises, thenables and missing returns before effects", async () => {
  // @ts-expect-error A promised assertion must never satisfy the publication interface.
  const invalidAsync: NativeAuthorityAdapter["assertSignerCurrent"] = async () => true
  void invalidAsync
  for (const hook of [
    async () => { throw new MissionAuthorityError("policy-unqualified") },
    async () => true,
    () => ({ then: () => { throw new Error("must not assimilate a thenable") } }),
    () => undefined,
  ]) {
    const f = await fixture()
    f.setFenceHook(hook)
    await assert.rejects(f.adopt(), rejects("trust-unavailable"))
    assert.equal((await f.store.read()).grants.length, 0)
    assert.equal((await f.store.read()).receipts.length, 0)
    assert.equal(f.effects(), 0)
  }
})

test("storage failure/ambiguous writes, unreadable namespace and another DB fail closed", async () => {
  for (const fault of ["before", "after"] as const) {
    const f = await fixture()
    const body = f.intent("update", { epoch: 0 })
    f.storage.setFault = fault
    await assert.rejects(f.execute(body), rejects("storage-unavailable"))
    assert.equal(f.effects(), 0)
    f.storage.setFault = undefined
    if (fault === "after") {
      const retry = await f.execute(body)
      assert.equal(retry.receipt.completion, undefined)
      assert.equal(f.effects(), 0)
    }
  }
  const f = await fixture(); await f.adopt(); await f.start()
  f.storage.getFault = true
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("storage-unavailable"))
  f.storage.getFault = false
  const namespaceKey = [...f.storage.values.keys()].find(key => key.endsWith("/namespace"))!
  f.storage.values.set(namespaceKey, randomUUID())
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("namespace-mismatch"))
  f.storage.values.delete(namespaceKey)
  await assert.rejects(f.store.initialize(), rejects("storage-invalid"))
  const other = await fixture({ projectID: f.scope.projectID })
  await assert.rejects(other.authority.execute(f.envelope(f.intent("adopt")), other.adapter, signal()), rejects("untrusted-signer"))
})

test("same daemon supports explicitly provisioned disjoint profile/project scopes; no global fallback", async () => {
  const storage = new NativeStyleStorage()
  const a = await fixture({ storage, profileID: "a" })
  const b = await fixture({ storage, profileID: "b" })
  assert.equal(a.scope.namespace, b.scope.namespace)
  const combined = [...a.signers(), ...b.signers()]
  a.setSigners(combined); b.setSigners(combined)
  await Promise.all([a.adopt(), b.adopt()])
  assert.equal((await a.store.read()).grants[0].profileID, "a")
  assert.equal((await b.store.read()).grants[0].profileID, "b")
  await assert.rejects(b.execute(b.intent("adopt", { profileID: "a", epoch: 2 })), rejects("untrusted-signer"))
})

test("rotation/downgrade/old-writer gates and replaced pinned key deny current admission", async () => {
  const f = await fixture(); await f.adopt(); await f.start()
  const provisioned = f.signers()[0]
  for (const qualification of ["rotation-pending", "old-writer-unexcluded", "downgrade-unqualified"] as const) {
    f.setSigners([{ ...provisioned, qualification }])
    await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("policy-unqualified"))
  }
  f.setSigners([{ ...provisioned, publicKey: generateKeyPairSync("ed25519").publicKey }])
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("untrusted-signer"))
  f.setSigners([provisioned])
  f.setMission({ ...f.mission()!, roots: [{ mode: "directory-only", directory: "/moved" }] })
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("binding-mismatch"))
  f.setObservationFault()
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("observation-unavailable"))
})

test("typed wrapper rejects every unsigned present/future human mutator and disposed apply", async () => {
  let reads = 0
  const handlers = rejectUnsignedMissionMutators({ snapshot: async () => ++reads, cleanupTarget: async () => ++reads,
    create: async () => true, lifecycle: async () => true, recover: async () => true, futureWriter: async () => true })
  await handlers.snapshot(); await handlers.cleanupTarget()
  for (const method of ["create", "lifecycle", "recover", "futureWriter"] as const) {
    await assert.rejects(handlers[method](), rejects("unsigned-privileged-method"))
  }
  assert.equal(reads, 2)
  const f = await fixture()
  let active = true
  const wrapped = missionAuthorityHandlers(f.authority, f.adapter, () => { if (!active) throw new Error("disposed") })
  const challenge = await wrapped.challenge({ nonce: "random-nonce-12345678" })
  assert.equal(challenge.namespace, f.scope.namespace)
  assert.equal(f.effects(), 0)
  active = false
  await assert.rejects(wrapped.intent(f.envelope(f.intent("adopt")), { signal: signal() }), /disposed/)
  assert.equal((await f.store.read()).receipts.length, 0)
})

test("final fresh read catches revocation during trust await; disposed incarnation cannot publish adoption", async () => {
  const f = await fixture(); await f.adopt(); await f.start()
  let trustReads = 0
  f.setSignerHook(async () => {
    if (++trustReads === 2) {
      f.setSignerHook()
      await f.execute(f.intent("revoke"))
    }
  })
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("authorization-blocked"))
  const other = await fixture()
  other.setSignerHook(async () => { other.dispose() })
  await assert.rejects(other.adopt(), rejects("authorization-blocked"))
  assert.equal((await other.store.read()).receipts.length, 0)
})

test("valid payload request conflict, result secret rejection and native restart reads", async () => {
  const f = await fixture()
  const update = f.intent("update", { epoch: 0 })
  await f.execute(update)
  await assert.rejects(f.execute({ ...update, payload: { objective: "Different valid payload" } } as AuthorityIntent), rejects("request-conflict"))
  const badResult = f.intent("update", { epoch: 0 })
  await assert.rejects(f.authority.execute(f.envelope(badResult), { apply: async body => ({ missionID: body.missionID,
    environment: { PASSWORD: "private secret" } }) as never }, signal()), rejects("invalid-intent"))
  assert.ok(!JSON.stringify(await f.store.read()).includes("PASSWORD"))
  const before = await f.store.read()
  const reloaded = new NativeMissionAuthorityStore(f.storage, f.scope.projectID, f.scope.projectCanonical)
  await reloaded.initialize()
  assert.deepEqual(await reloaded.read(), before)
  assert.equal(f.effects(), 1)
})

test("prepared creation is signed/deterministic and a competing pending create cannot duplicate effects", async () => {
  const f = await fixture(); f.setMission(undefined)
  const creation = f.intent("create")
  let entered!: () => void; let release!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const creating = f.authority.execute(f.envelope(creation), { apply: async body => { entered(); await held; return f.adapter.apply(body) } }, signal())
  await enteredPromise
  await assert.rejects(f.execute(f.intent("create")), rejects("revision-conflict"))
  assert.equal((await f.execute(creation)).receipt.completion, undefined)
  release(); await creating
  assert.equal(f.effects(), 1)
  assert.equal(f.mission()?.runState, "prepared")
  assert.equal((await f.store.read()).grants.length, 0)
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("authorization-blocked"))
})

test("storage seam enforces immutable receipts, monotonic revoked epochs and permanent terminal denial", async () => {
  const f = await fixture(); await f.adopt(); await f.execute(f.intent("revoke"))
  await assert.rejects(f.store.transaction(async doc => { doc.receipts[0].intent.expectedRevision++ }), rejects("request-conflict"))
  await assert.rejects(f.store.transaction(async doc => { doc.receipts[0].completion!.result = { metadataOnly: false } }), rejects("request-conflict"))
  await assert.rejects(f.store.transaction(async doc => { doc.grants[0].state = "active" }), rejects("epoch-conflict"))
  await assert.rejects(f.store.transaction(async doc => { doc.grants = [] }), rejects("epoch-conflict"))
  assert.equal((await f.store.read()).grants[0].state, "revoked")
  await f.execute(f.intent("delete"))
  await assert.rejects(f.store.transaction(async doc => { doc.terminals = [] }), rejects("authorization-blocked"))
  assert.equal((await f.authority.state("mission-one")).terminal, "deleted")
})

test("real native journal retains admitted late report evidence independently of revoked send authority", async () => {
  const f = await fixture(); await f.adopt(); await f.start(); await f.execute(f.intent("revoke"))
  const journal = new MissionJournal(f.storage, f.scope.projectID, f.scope.projectCanonical)
  const event = { version: 1 as const, id: "event-late-report", missionID: "mission-one", projectID: f.scope.projectID,
    createdAt: 100, type: "task.reported" as const,
    report: { id: "report-late", taskKey: "task-one", sessionId: "session-actor", outcome: "completed" as const,
      summary: "Already admitted work", evidence: ["Immutable evidence"], next: [], createdAt: 100, late: true,
      artifact: { proof: "Existing native evidence" } },
  }
  // Actor/admission validation belongs to the report owner; append is not a send.
  await journal.append(event)
  assert.deepEqual(await journal.event("mission-one", "event-late-report"), event)
  await assert.rejects(f.authority.assertAdmission(f.admission()), rejects("authorization-blocked"))
  assert.deepEqual(await journal.event("mission-one", "event-late-report"), event)
})
