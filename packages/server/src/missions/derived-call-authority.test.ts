import assert from "node:assert/strict"
import test from "node:test"
import { authorityDigest, canonicalAuthority } from "./authority-protocol"
import { fixture as protectedFixture } from "./host-authority/test-fixture"
import { DerivedCallAuthority, type DerivedCallBusiness, type DerivedTaskObservation } from "./derived-call-authority"
import { derivedReservationID, type DerivedCallBody, type DerivedChildBinding, type DerivedInvocationLease,
  type DerivedInvocationVerifier, type DerivedInvocationPurpose, type DerivedTaskReference } from "./derived-call-protocol"

// Structural adapters only. Real protected file/signature/native authority code;
// injected writer proof/shared journal observations are NOT native qualification.
const signal = () => new AbortController().signal
const same = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
async function fixture() {
  const f = await protectedFixture()
  await f.prepare(); await f.execute(await f.body("adopt", {})); await f.execute(await f.body("lifecycle", { action: "start" }))
  const state = (await f.host.read())!, signer = state.signer!, grant = state.mirror!
  const tasks = new Map<string, DerivedTaskObservation>(), children = new Map<string, DerivedChildBinding>()
  const accepted = new Map<string, string>(), proofs = new WeakMap<object, DerivedInvocationLease>()
  let proofCurrent = true, businessCurrent = true, idle = true, idleReads = 0
  let observeHook: (() => void | Promise<void>) | undefined, childHook: (() => void | Promise<void>) | undefined
  let currentHook: (() => unknown) | undefined
  const key = (ref: DerivedTaskReference) => `${ref.taskKey}/${ref.generation}`
  const body = (taskKey = "task-one", options: Partial<DerivedCallBody> = {}): DerivedCallBody => {
    const { reservationID: _, ...rest } = options
    const identity: Omit<DerivedCallBody, "reservationID"> = { ...state.binding, version: 1,
      policy: "codenomad.missions.native-call/signed-v1", epoch: grant.epoch,
      provisioningGeneration: signer.provisioningGeneration, signerDigest: signer.signerDigest,
      task: { taskKey, generation: 1 }, taskContractDigest: authorityDigest({ taskKey }), parentTask: null,
      parentSessionID: state.binding.coordinatorSessionID, parentMessageID: `msg_${taskKey}`, toolCallID: `call_${taskKey}`,
      choice: { kind: "new" }, execution: {}, root: state.binding.roots[0], ...rest }
    const value = { ...identity, reservationID: derivedReservationID(identity) }
    if (!tasks.has(key(value.task))) tasks.set(key(value.task), { reference: value.task, contractDigest: value.taskContractDigest,
      execution: value.execution, current: true, running: true, dependenciesCompleted: true,
      parent: value.parentTask ? { reference: value.parentTask, sessionID: value.parentSessionID } : null,
      actors: [state.binding.coordinatorSessionID], completedReport: false })
    return value
  }
  const invocation = (value: DerivedCallBody, purpose: DerivedInvocationPurpose, childSessionID?: string, outcome?: "returned" | "error") => {
    const proof = Object.freeze({})
    proofs.set(proof, { bodyDigest: authorityDigest(value), purpose, childSessionID, outcome,
      callerSessionID: purpose === "execute" || purpose === "report" ? childSessionID! : value.parentSessionID,
      assertCurrent() { if (!proofCurrent) throw new Error("fixture native writer lost"); return true } })
    return proof
  }
  const verifier: DerivedInvocationVerifier = { async verify(input) {
    if (!input.proof || typeof input.proof !== "object") throw new Error("unknown fixture proof")
    const lease = proofs.get(input.proof)
    if (!lease) throw new Error("unknown fixture proof")
    return lease
  } }
  const business: DerivedCallBusiness = {
    async observe(_body, ref) { await observeHook?.(); const value = tasks.get(key(ref)); if (!value) throw new Error("unknown shared task"); return structuredClone(value) },
    async child(id) { await childHook?.(); const value = children.get(id); if (!value) throw new Error("unknown native child"); return structuredClone(value) },
    async accepted(value, child) { if (accepted.get(value.reservationID) !== child.sessionID) throw new Error("shared binding not accepted"); return true },
    assertCurrent(value, purpose) {
      if (currentHook) return currentHook() as true
      const task = tasks.get(key(value.task))
      if (!businessCurrent || !task || !same(task.reference, value.task) || task.contractDigest !== value.taskContractDigest
        || ["reserve", "bind", "execute"].includes(purpose) && (!task.current || !task.running)) throw new Error("shared task superseded")
      return true
    },
    async assertIdle() { idleReads++; if (!idle) throw new Error("native busy"); return true },
  }
  const deps = { store: f.core.store, native: f.core, host: f.host, business, invocations: verifier }
  const authority = new DerivedCallAuthority(deps)
  const start = async (value: DerivedCallBody) => {
    await authority.reserve(value, invocation(value, "reserve"), signal())
    const admitted = await authority.admitNative(value.reservationID, invocation(value, "reserve"), signal())
    assert.equal(admitted.assertCurrent(), true)
    return admitted
  }
  const publishChild = (value: DerivedCallBody, id = "ses_child") => {
    children.set(id, { sessionID: id, parentSessionID: value.parentSessionID, root: value.root, execution: value.execution })
    accepted.set(value.reservationID, id)
    const task = tasks.get(key(value.task))!
    task.actors = [...new Set([...task.actors, id])]
    task.binding = { childSessionID: id, parentSessionID: value.parentSessionID, generation: value.task.generation,
      toolCallID: value.toolCallID, parentMessageID: value.parentMessageID }
  }
  const bind = async (value: DerivedCallBody, id = "ses_child") => {
    publishChild(value, id)
    return authority.bind(value.reservationID, id, invocation(value, "bind", id), signal())
  }
  const end = async (value: DerivedCallBody, id = "ses_child", outcome: "returned" | "error" = "returned") => {
    const result = await authority.end(value.reservationID, outcome, invocation(value, "end", id, outcome), signal())
    tasks.get(key(value.task))!.binding!.ended = outcome
    return result
  }
  return { f, body, authority, deps, tasks, children, accepted, proofs, invocation, start, bind, publishChild, end, key,
    setIdle(value: boolean) { idle = value }, idleReads: () => idleReads,
    loseProof() { proofCurrent = false }, loseBusiness() { businessCurrent = false },
    onObserve(hook?: () => void | Promise<void>) { observeHook = hook }, onChild(hook?: () => void | Promise<void>) { childHook = hook },
    onCurrent(hook?: () => unknown) { currentHook = hook } }
}

test("real protected root grant derives autonomous domain-separated authority without a human request or host mutation", async t => {
  const g = await fixture(); t.after(g.f.cleanup)
  const before = await g.f.readRaw(), body = g.body()
  g.f.loseAuth()
  const record = await g.authority.reserve(body, g.invocation(body, "reserve"), signal())
  assert.equal(record.state, "reserved"); assert.deepEqual(record.signed.body, body)
  assert.deepEqual(await g.f.readRaw(), before, "derivation neither stages nor changes root approval")
  assert.equal((await g.authority.read(body.reservationID))!.digest, authorityDigest(body))
  assert(!JSON.stringify(record).includes("privateKey"))
  await assert.rejects(g.f.host.sign(g.f.request, await g.f.body("update", { objective: "still human only" }), before!.revision), /human-auth-required/)
})

test("missing or forged invocation proof fails closed before native reservation or host mutation", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(), before = await g.f.core.store.read()
  for (const authority of [new DerivedCallAuthority({ ...g.deps, invocations: undefined }), g.authority]) {
    await assert.rejects(authority.reserve(body, {}, signal()))
  }
  await assert.rejects(g.authority.reserve(body, undefined, signal()))
  const rawLease: DerivedInvocationLease = { bodyDigest: authorityDigest(body), purpose: "reserve",
    callerSessionID: body.parentSessionID, assertCurrent: () => true }
  const host = (await g.f.host.read())!
  assert.throws(() => g.f.host.signDerivedCall(body, host.mirror!, rawLease), /policy-unqualified/,
    "raw structural leases cannot bypass the mandatory verifier at the host signer")
  assert.deepEqual(await g.f.core.store.read(), before)
})

test("reservation, native entry, shared binding and execution are separate one-way stages with no replay", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body()
  await g.authority.reserve(body, g.invocation(body, "reserve"), signal())
  await assert.rejects(g.authority.reserve(body, g.invocation(body, "reserve"), signal()), /request-conflict/)
  await assert.rejects(g.authority.authorize(body.reservationID, "execute", {}, signal()))
  const admitted = await g.authority.admitNative(body.reservationID, g.invocation(body, "reserve"), signal())
  assert.equal(admitted.assertCurrent(), true); assert.throws(() => admitted.assertCurrent())
  await assert.rejects(g.authority.admitNative(body.reservationID, g.invocation(body, "reserve"), signal()))
  assert.equal((await g.authority.read(body.reservationID))!.state, "invoking")
  await g.bind(body)
  const approved = await g.authority.authorize(body.reservationID, "execute", g.invocation(body, "execute", "ses_child"), signal())
  assert.equal(approved.assertCurrent(), true); assert.equal(approved.late, false)
  assert.ok(Object.isFrozen(approved.body)); assert.ok(Object.isFrozen(approved.body.task))
  await assert.rejects(g.bind(body), /authorization-blocked/)
  await g.end(body)
  await assert.rejects(g.authority.authorize(body.reservationID, "execute", g.invocation(body, "execute", "ses_child"), signal()))
})

test("unaccepted journal binding or native identity mismatch cannot activate a born child", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body)
  g.children.set("ses_child", { sessionID: "ses_child", parentSessionID: body.parentSessionID, root: body.root, execution: {} })
  await assert.rejects(g.authority.bind(body.reservationID, "ses_child", g.invocation(body, "bind", "ses_child"), signal()))
  assert.equal((await g.authority.read(body.reservationID))!.state, "invoking")
  g.accepted.set(body.reservationID, "ses_child")
  g.children.get("ses_child")!.parentSessionID = "ses_foreign"
  await assert.rejects(g.authority.bind(body.reservationID, "ses_child", g.invocation(body, "bind", "ses_child"), signal()), /binding-mismatch/)
  assert.equal((await g.authority.read(body.reservationID))!.child, undefined)
})

for (const purpose of ["bind", "execute", "report", "end"] as const) {
  test(`hostile sibling/ancestor proof cannot borrow ${purpose} authority`, async t => {
    const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body)
    if (purpose === "bind") g.publishChild(body)
    else await g.bind(body)
    const before = await g.authority.read(body.reservationID)
    const proof = g.invocation(body, purpose, "ses_child", purpose === "end" ? "returned" : undefined)
    const lease = g.proofs.get(proof)!
    g.proofs.set(proof, { ...lease, callerSessionID: "ses_sibling" })
    const action = purpose === "end" ? g.authority.end(body.reservationID, "returned", proof, signal())
      : purpose === "bind" ? g.authority.bind(body.reservationID, "ses_child", proof, signal())
      : g.authority.authorize(body.reservationID, purpose, proof, signal())
    await assert.rejects(action)
    assert.deepEqual(await g.authority.read(body.reservationID), before)
  })
}

test("current native-call outcome proof cannot be relabeled as a successful return", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); await g.bind(body)
  await assert.rejects(g.authority.end(body.reservationID, "returned", g.invocation(body, "end", "ses_child", "error"), signal()), /binding-mismatch/)
  assert.equal((await g.authority.read(body.reservationID))!.state, "active")
  await g.end(body, "ses_child", "error")
  await assert.rejects(g.end(body, "ses_child", "returned"))
})

test("task-local retirement fences execution but admitted report evidence survives protected local revoke", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); await g.bind(body)
  const old = await g.authority.authorize(body.reservationID, "execute", g.invocation(body, "execute", "ses_child"), signal())
  g.tasks.get(g.key(body.task))!.current = false
  const host = (await g.f.host.read())!
  await g.f.host.revoke(g.f.request, host.revision)
  assert.throws(() => old.assertCurrent())
  await assert.rejects(g.authority.authorize(body.reservationID, "execute", g.invocation(body, "execute", "ses_child"), signal()))
  const report = await g.authority.authorize(body.reservationID, "report", g.invocation(body, "report", "ses_child"), signal())
  assert.equal(report.late, true); assert.equal(report.assertCurrent(), true)
  await g.end(body)
  assert.equal((await g.authority.read(body.reservationID))!.ended, "returned")
  assert.equal((await g.f.host.read())!.state, "revoked", "evidence never re-enables the root")
})

test("unrelated journal/task revisions do not invalidate exact task generation", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); await g.bind(body)
  g.body("other-task", { task: { taskKey: "other-task", generation: 9 } })
  const report = await g.authority.authorize(body.reservationID, "report", g.invocation(body, "report", "ses_child"), signal())
  assert.equal(report.late, false)
  assert.equal((await g.authority.authorize(body.reservationID, "execute", g.invocation(body, "execute", "ses_child"), signal())).assertCurrent(), true)
})

test("immediate task/known-child busy refusal never waits for idle or delays a continuation", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); await g.bind(body)
  const other = g.body("task-one", { toolCallID: "call_overlap", parentMessageID: "msg_overlap", choice: { kind: "continue", sessionID: "ses_child" } })
  g.setIdle(false)
  await assert.rejects(g.authority.reserve(other, g.invocation(other, "reserve"), signal()), /authorization-blocked/)
  assert.equal(g.idleReads(), 0)
  const sibling = g.body("other", { choice: { kind: "reuse", sessionID: "ses_child", fromTask: body.task } })
  await assert.rejects(g.authority.reserve(sibling, g.invocation(sibling, "reserve"), signal()), /authorization-blocked/)
  assert.equal(g.idleReads(), 0)
})

test("explicit exact-child reuse needs selected source, completed report, native return and authoritative idle", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); await g.bind(body); await g.end(body)
  const next = g.body("implementation", { choice: { kind: "reuse", sessionID: "ses_child", fromTask: body.task } })
  const task = g.tasks.get(g.key(next.task))!
  task.reuseFromTask = body.task; task.actors.push("ses_child")
  const reserve = () => g.authority.reserve(next, g.invocation(next, "reserve"), signal())
  await assert.rejects(reserve(), /binding-mismatch/)
  g.tasks.get(g.key(body.task))!.completedReport = true
  g.setIdle(false); await assert.rejects(reserve(), /authorization-blocked/)
  g.setIdle(true); await reserve()
  assert.equal((await g.authority.read(body.reservationID))!.ended, "returned")
  const withoutChild = g.body("implementation", { toolCallID: "call_fresh", parentMessageID: "msg_fresh" })
  await assert.rejects(g.authority.reserve(withoutChild, g.invocation(withoutChild, "reserve"), signal()))
})

test("same-task continuation may follow exact error termination without falsely requiring an old completed report", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); await g.bind(body); await g.end(body, "ses_child", "error")
  const next = g.body("task-one", { toolCallID: "call_next", parentMessageID: "msg_next", choice: { kind: "continue", sessionID: "ses_child" } })
  await g.start(next); await g.bind(next)
  assert.equal((await g.authority.read(body.reservationID))!.ended, "error")
  assert.equal((await g.authority.read(next.reservationID))!.state, "active")
})

test("nested parent reference verifies its OWN generation and requires accepted derived parent authority", async t => {
  const g = await fixture(); t.after(g.f.cleanup)
  const parent = g.body("parent", { task: { taskKey: "parent", generation: 4 } }); await g.start(parent); await g.bind(parent, "ses_parent")
  const child = g.body("nested", { task: { taskKey: "nested", generation: 2 }, parentTask: parent.task, parentSessionID: "ses_parent" })
  g.tasks.get(g.key(child.task))!.actors.push("ses_parent")
  await g.start(child); await g.bind(child, "ses_nested")
  const bad = g.body("nested-other", { parentTask: { taskKey: "parent", generation: 2 }, parentSessionID: "ses_parent" })
  await assert.rejects(g.authority.reserve(bad, g.invocation(bad, "reserve"), signal()))
  g.tasks.get(g.key(parent.task))!.current = false
  await assert.rejects(g.authority.authorize(child.reservationID, "execute", g.invocation(child, "execute", "ses_nested"), signal()))
})

test("parallel siblings can share an assistant message while atomically reserving the last unique actor slot", async t => {
  const g = await fixture(); t.after(g.f.cleanup)
  const a = g.body("sibling-a", { parentMessageID: "msg_shared" }), b = g.body("sibling-b", { parentMessageID: "msg_shared" })
  const actors = [a.coordinatorSessionID, ...Array.from({ length: 6 }, (_, i) => `ses_existing_${i}`)]
  g.tasks.get(g.key(a.task))!.actors = actors; g.tasks.get(g.key(b.task))!.actors = actors
  const other = new DerivedCallAuthority(g.deps)
  const results = await Promise.allSettled([g.authority.reserve(a, g.invocation(a, "reserve"), signal()), other.reserve(b, g.invocation(b, "reserve"), signal())])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  assert.equal(results.filter(result => result.status === "rejected").length, 1)
  assert.equal((await g.f.core.store.read()).derivedCalls!.length, 1)
})

test("at actor cap, a fresh birth is denied before reservation; exact-child continuation consumes no slot", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); await g.bind(body); await g.end(body)
  const next = g.body("task-one", { toolCallID: "call_cap", parentMessageID: "msg_cap", choice: { kind: "continue", sessionID: "ses_child" } })
  g.tasks.get(g.key(next.task))!.actors = [body.coordinatorSessionID, "ses_child", ...Array.from({ length: 6 }, (_, i) => `ses_extra_${i}`)]
  await g.authority.reserve(next, g.invocation(next, "reserve"), signal())
  const fresh = g.body("fresh-cap")
  g.tasks.get(g.key(fresh.task))!.actors = [...g.tasks.get(g.key(next.task))!.actors]
  await assert.rejects(g.authority.reserve(fresh, g.invocation(fresh, "reserve"), signal()), /capacity/)
  assert.equal(await g.authority.read(fresh.reservationID), undefined)
})

for (const stage of ["reserve", "bind", "execute"] as const) {
  test(`proof/currentness loss during ${stage} preparation fails closed and retains honest evidence`, async t => {
    const g = await fixture(); t.after(g.f.cleanup); const body = g.body()
    if (stage !== "reserve") await g.start(body)
    if (stage === "execute") await g.bind(body)
    g.onObserve(() => { g.loseProof() })
    const action = stage === "reserve" ? g.authority.reserve(body, g.invocation(body, "reserve"), signal())
      : stage === "bind" ? g.bind(body)
      : g.authority.authorize(body.reservationID, "execute", g.invocation(body, "execute", "ses_child"), signal())
    await assert.rejects(action)
    assert.equal((await g.authority.read(body.reservationID))?.state, stage === "reserve" ? undefined : stage === "bind" ? "invoking" : "active")
  })
}

test("promise/thenable/missing-return business publication fences cannot publish reservations", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body()
  for (const value of [undefined, Promise.resolve(true), { then() { throw new Error("never assimilate") } }]) {
    g.onCurrent(() => value)
    await assert.rejects(g.authority.reserve(body, g.invocation(body, "reserve"), signal()), /policy-unqualified/)
    assert.equal(await g.authority.read(body.reservationID), undefined)
  }
})

test("derived claims share bounded metadata quota and cannot spend future root denial capacity", async t => {
  const g = await fixture(); t.after(g.f.cleanup)
  g.f.core.store.capacity.receipts = 4 // adopt + Play + future root denial + one derived call
  const body = g.body(); await g.authority.reserve(body, g.invocation(body, "reserve"), signal())
  const next = g.body("next")
  await assert.rejects(g.authority.reserve(next, g.invocation(next, "reserve"), signal()), /capacity/)
  await g.f.execute(await g.f.body("revoke", {}))
  assert.equal((await g.f.host.read())!.mirror!.state, "revoked")
})

test("store rejects removal, skipped activation, signed identity changes and terminal reinterpretation", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body()
  await g.authority.reserve(body, g.invocation(body, "reserve"), signal())
  const before = await g.f.core.store.read()
  await assert.rejects(g.f.core.store.transaction(async doc => { doc.derivedCalls = [] }), /request-conflict/)
  await assert.rejects(g.f.core.store.transaction(async doc => {
    const call = doc.derivedCalls![0]; call.state = "active"
    call.child = { sessionID: "ses_child", parentSessionID: body.parentSessionID, root: body.root, execution: {} }
  }), /request-conflict/)
  assert.deepEqual(await g.f.core.store.read(), before)
  await assert.rejects(g.f.core.store.transaction(async doc => { doc.derivedCalls![0].signed.signature = "A".repeat(86) + "==" }), /request-conflict/)
  const admitted = await g.authority.admitNative(body.reservationID, g.invocation(body, "reserve"), signal())
  admitted.assertCurrent(); await g.bind(body); await g.end(body)
  const ended = await g.f.core.store.read()
  await assert.rejects(g.f.core.store.transaction(async doc => { doc.derivedCalls![0].ended = "error" }), /request-conflict/)
  await assert.rejects(g.f.core.store.transaction(async doc => { doc.derivedCalls![0].state = "active"; delete doc.derivedCalls![0].ended }), /request-conflict/)
  assert.deepEqual(await g.f.core.store.read(), ended)
})

test("business acceptance cannot substitute a different Tool/message/generation/actor binding", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); g.publishChild(body)
  const task = g.tasks.get(g.key(body.task))!, original = structuredClone(task)
  for (const change of [{ toolCallID: "foreign-tool" }, { parentMessageID: "foreign-message" }, { generation: 7 }, { childSessionID: "ses_sibling" }]) {
    task.binding = { ...original.binding!, ...change }
    await assert.rejects(g.authority.bind(body.reservationID, "ses_child", g.invocation(body, "bind", "ses_child"), signal()), /binding-mismatch/)
    assert.equal((await g.authority.read(body.reservationID))!.state, "invoking")
  }
  task.binding = original.binding; task.actors = [body.coordinatorSessionID]
  await assert.rejects(g.authority.bind(body.reservationID, "ses_child", g.invocation(body, "bind", "ses_child"), signal()), /binding-mismatch/)
})

test("actual child execution changes across binding reads cannot borrow unspecified defaults", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); g.publishChild(body)
  let reads = 0
  g.onChild(() => { if (++reads === 2) g.children.get("ses_child")!.execution = { agent: "changed-native-default" } })
  await assert.rejects(g.authority.bind(body.reservationID, "ses_child", g.invocation(body, "bind", "ses_child"), signal()), /binding-mismatch/)
  assert.equal((await g.authority.read(body.reservationID))!.state, "invoking")
})

test("competing original-executor admissions yield only one consumable entry, including across seam instances", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body()
  await g.authority.reserve(body, g.invocation(body, "reserve"), signal())
  const other = new DerivedCallAuthority(g.deps)
  const results = await Promise.allSettled([g.authority.admitNative(body.reservationID, g.invocation(body, "reserve"), signal()),
    other.admitNative(body.reservationID, g.invocation(body, "reserve"), signal())])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  assert.equal((await g.authority.read(body.reservationID))!.state, "invoking")
})

for (const action of ["pause", "stop"] as const) {
  test(`protected/native ${action} agreement denies sends without discarding admitted report/end evidence`, async t => {
    const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); await g.bind(body)
    await g.f.execute(await g.f.body("lifecycle", { action }))
    await assert.rejects(g.authority.authorize(body.reservationID, "execute", g.invocation(body, "execute", "ses_child"), signal()))
    const report = await g.authority.authorize(body.reservationID, "report", g.invocation(body, "report", "ses_child"), signal())
    assert.equal(report.assertCurrent(), true); await g.end(body)
    assert.equal((await g.f.host.read())!.mirror!.sendsEnabled, false)
  })
}

test("protected staged/native disagreement fails closed before autonomous signing and never accepts itself", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body()
  const update = await g.f.body("update", { objective: "human update pending" })
  await g.f.host.sign(g.f.request, update, (await g.f.host.read())!.revision)
  const before = await g.f.readRaw()
  await assert.rejects(g.authority.reserve(body, g.invocation(body, "reserve"), signal()))
  assert.equal(await g.authority.read(body.reservationID), undefined)
  assert.deepEqual(await g.f.readRaw(), before)
})

test("native root denial without protected acceptance cannot be substituted by a cached host grant", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body()
  await g.f.core.store.transaction(async doc => { doc.grants[0].state = "revoked"; doc.grants[0].sendsEnabled = false })
  await assert.rejects(g.authority.reserve(body, g.invocation(body, "reserve"), signal()))
  assert.equal(await g.authority.read(body.reservationID), undefined)
})

test("signer rotation never validates an old signed call as new-generation report/end evidence", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); await g.bind(body)
  await g.f.execute(await g.f.body("revoke", {}))
  const local = await g.f.host.revoke(g.f.request, (await g.f.host.read())!.revision)
  await g.f.host.prepare(g.f.request, g.f.target, local.revision)
  await assert.rejects(g.authority.authorize(body.reservationID, "report", g.invocation(body, "report", "ses_child"), signal()))
  await assert.rejects(g.end(body))
  assert.equal((await g.authority.read(body.reservationID))!.state, "active")
})

test("pending derived bytes preserve future root denial capacity without signing a repair", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(), before = await g.f.core.store.read()
  let lo = 1, hi = g.f.core.store.capacity.bytes
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2); g.f.core.store.capacity.bytes = mid
    try { g.f.core.store.assertCapacity(before); hi = mid } catch { lo = mid + 1 }
  }
  g.f.core.store.capacity.bytes = lo
  await assert.rejects(g.authority.reserve(body, g.invocation(body, "reserve"), signal()), /capacity/)
  assert.deepEqual(await g.f.core.store.read(), before)
  await g.f.execute(await g.f.body("revoke", {}))
  assert.equal((await g.f.host.read())!.mirror!.state, "revoked")
})

test("runtime purpose cannot escalate execute/report authority to root finalization or generic calls", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(); await g.start(body); await g.bind(body)
  for (const purpose of ["end", "finalize", "session.prompt", "reserve"]) {
    await assert.rejects(g.authority.authorize(body.reservationID, purpose as "execute", {}, signal()), /invalid-intent/)
  }
})

test("pre-aborted calls do not sign/reserve and abandoned invoking state survives reconstruction without replay", async t => {
  const g = await fixture(); t.after(g.f.cleanup); const body = g.body(), abort = new AbortController(); abort.abort()
  await assert.rejects(g.authority.reserve(body, g.invocation(body, "reserve"), abort.signal))
  assert.equal(await g.authority.read(body.reservationID), undefined)
  await g.start(body)
  const reloaded = new DerivedCallAuthority(g.deps)
  assert.equal((await reloaded.read(body.reservationID))!.state, "invoking")
  await assert.rejects(reloaded.admitNative(body.reservationID, g.invocation(body, "reserve"), signal()))
  await assert.rejects(reloaded.reserve(body, g.invocation(body, "reserve"), signal()))
  assert.equal((await reloaded.read(body.reservationID))!.state, "invoking")
})
