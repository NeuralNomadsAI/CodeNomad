import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { ProjectParticipants } from "./project-participants"

const ref = (serverId = "A", directory = "Z:\\Opaque\\é/שלום ") => ({ tabId: randomUUID(), serverId, directory })
const unavailable = () => { assert.fail("metadata must not read files, sessions, providers or credentials") }

test("scoped declarations retain exact homonyms and independent occurrence lifetimes, never global absence", () => {
  const owner = new ProjectParticipants(), before = owner.snapshot("A")
  const a = owner.register("cookie-A", () => true)!, b = owner.register("cookie-B", () => true)!
  assert.equal(owner.isCurrent(before.receipt), false)
  assert.equal(owner.admit(a.grant.token, "cookie-B"), undefined)
  const refs = [ref(), ref(), ref("B")]
  assert.equal(owner.admit(a.grant.token, "cookie-A")!.publish({ revision: 1, refs }, unavailable), true)
  assert.equal(owner.admit(b.grant.token, "cookie-B")!.publish({ revision: 1, refs: [ref()] }, unavailable), true)
  const captured = owner.snapshot("A")
  assert.equal(captured.refs.length, 3)
  assert.equal(new Set(captured.refs.map(value => value.tabId)).size, 3)
  assert.ok(captured.refs.every(value => value.directory === refs[0]!.directory))
  assert.equal(captured.status, "unknown")
  assert.equal(owner.isCurrent(captured.receipt), true)
  assert.equal(owner.admit(a.grant.token, "cookie-A")!.publish({ revision: 2, refs: [] }, unavailable), true)
  assert.equal(owner.snapshot("A").refs.length, 1, "one window never clears its sibling")
  assert.equal(owner.isCurrent(captured.receipt), false)
  assert.doesNotMatch(JSON.stringify(owner.snapshot("A")), new RegExp(`${a.grant.token}|${b.grant.token}|cookie-A|cookie-B`))
  owner.dispose()
})

test("pre-body admissions, held/out-of-order bodies, replay and close retire receipts irreversibly", () => {
  const owner = new ProjectParticipants(), stream = owner.register("principal", () => true)!
  const publish = (revision: number) => owner.admit(stream.grant.token, "principal")!.publish({ revision, refs: [ref()] }, unavailable)
  assert.equal(publish(1), true)
  const before = owner.snapshot("A"), old = owner.admit(stream.grant.token, "principal")!
  assert.equal(owner.isCurrent(before.receipt), false, "admission revokes before a body exists")
  const fresh = owner.admit(stream.grant.token, "principal")!
  assert.equal(fresh.publish({ revision: 3, refs: [ref()] }, unavailable), true)
  assert.equal(old.publish({ revision: 2, refs: [] }, unavailable), false)
  assert.equal(publish(3), false)
  assert.equal(owner.snapshot("A").owners[0]!.observation, "unknown")
  assert.equal(publish(4), true)
  const stable = owner.snapshot("A")
  stream.close(); stream.close()
  assert.equal(owner.isCurrent(stable.receipt), false)
  assert.equal(owner.admit(stream.grant.token, "principal"), undefined)
  assert.equal(owner.snapshot("A").unresolvedOwners, 1)
  assert.equal(owner.snapshot("A").refs.length, 1, "loss keeps bounded positive refs with unknown coverage")
  assert.equal(owner.snapshot("A").status, "unknown")
  const replacement = owner.register("principal", () => true)!
  assert.notEqual(replacement.grant.token, stream.grant.token)
  assert.equal(owner.admit(replacement.grant.token, "principal")!.publish({ revision: 1, refs: [ref()] }, unavailable), true)
  assert.equal(owner.isCurrent(stable.receipt), false)
  owner.dispose()
  assert.equal(owner.isCurrent(owner.snapshot("A").receipt), false)
})

test("binding provenance, principal loss and same-ID replacement fence current before IO", () => {
  const owner = new ProjectParticipants(); let authorized = true, identity: object = {}, calls = 0
  const stream = owner.register("principal", () => authorized)!
  const resolve = () => { calls++; return { owner: identity, serverId: "A", directory: "/same" } }
  const value = { revision: 1, refs: [{ ...ref("A", "/same"), workspaceId: "same" }] }
  assert.equal(owner.admit(stream.grant.token, "principal")!.publish(value, resolve), true)
  const captured = owner.snapshot("A")
  identity = {}
  assert.equal(owner.isCurrent(captured.receipt), false)
  assert.equal(owner.snapshot("A").owners[0]!.observation, "unknown")
  assert.equal(owner.admit(stream.grant.token, "principal")!.publish({ ...value, revision: 2 }, resolve), true)
  const newer = owner.snapshot("A")
  authorized = false
  const before = calls
  assert.equal(owner.isCurrent(newer.receipt), false)
  assert.equal(calls, before, "revocation precedes binding resolution")
  authorized = true
  assert.equal(owner.admit(stream.grant.token, "principal"), undefined, "authorization returning never revives the retired grant")
  assert.equal(owner.isCurrent(newer.receipt), false)
})

test("strict metadata limits reject selectors and forged refs before resolution, with a fresh positive after each refusal", () => {
  const owner = new ProjectParticipants(), stream = owner.register("principal", () => true)!
  let revision = 0
  for (const invalid of [
    { profile: "other" }, { config: "/secret" }, { ownerId: randomUUID() }, { credential: "PRIVATE" },
    { refs: [ref("../bad")] }, { refs: [ref("A", "x\0y")] }, { refs: [ref("A", "x".repeat(4097))] },
    { refs: Array.from({ length: 33 }, () => ref()) }, { refs: [ref(), { ...ref(), draft: "PRIVATE" }] },
  ]) {
    assert.equal(owner.admit(stream.grant.token, "principal")!.publish({ revision: ++revision, refs: [], ...invalid }, unavailable), false)
    assert.equal(owner.admit(stream.grant.token, "principal")!.publish({ revision: ++revision, refs: [ref()] }, unavailable), true)
    assert.equal(owner.snapshot("A").status, "unknown")
  }
  const duplicate = ref()
  assert.equal(owner.admit(stream.grant.token, "principal")!.publish({ revision: ++revision, refs: [duplicate, duplicate] }, unavailable), false)
  assert.equal(owner.admit(stream.grant.token, "principal")!.publish({ revision: ++revision, refs: [ref()] }, unavailable), true)
  assert.equal(owner.admit(stream.grant.token, "principal")!.publish({ revision: ++revision, refs: [], unknown: true }, unavailable), true)
  assert.equal(owner.snapshot("A").owners[0]!.observation, "unknown")
})

test("32-owner/512-ref ceilings preserve unknown without TTL reclamation or enlarged test limits", () => {
  const owner = new ProjectParticipants()
  const streams = Array.from({ length: 32 }, () => owner.register("principal", () => true)!)
  for (const stream of streams.slice(0, 16)) assert.equal(owner.admit(stream.grant.token, "principal")!.publish({ revision: 1, refs: Array.from({ length: 32 }, () => ref()) }, unavailable), true)
  assert.equal(owner.snapshot("A").refs.length, 512)
  const admission = owner.admit(streams[16]!.grant.token, "principal")!, captured = owner.snapshot("A")
  assert.equal(captured.overflow, false)
  assert.equal(admission.publish({ revision: 1, refs: [ref()] }, unavailable), false)
  assert.equal(owner.isCurrent(captured.receipt), false, "overflow after a held body retires its observable snapshot")
  assert.equal(owner.register("principal", () => true), undefined)
  streams[0]!.close()
  assert.equal(owner.snapshot("A").refs.length, 512)
  assert.equal(owner.snapshot("A").overflow, true)
  assert.equal(owner.snapshot("A").status, "unknown")
  assert.equal(owner.register("principal", () => true), undefined)
  assert.equal(owner.admit(streams[1]!.grant.token, "principal")!.publish({ revision: 2, refs: [ref()] }, unavailable), true)
  assert.equal(owner.snapshot("A").refs.length, 481)
})

test("authorization loss observed inside an admitted publication retires the grant across return ABA", () => {
  const owner = new ProjectParticipants(); let authorized = true
  const stream = owner.register("principal", () => authorized)!, admitted = owner.admit(stream.grant.token, "principal")!
  const value = { revision: 1, refs: [{ ...ref("A", "/same"), workspaceId: "same" }] }
  assert.equal(admitted.publish(value, () => { authorized = false; return { serverId: "A", directory: "/same", owner: {} } }), false)
  authorized = true
  assert.equal(owner.admit(stream.grant.token, "principal"), undefined)
  const fresh = owner.register("principal", () => true)!
  assert.equal(owner.admit(fresh.grant.token, "principal")!.publish({ revision: 1, refs: [ref()] }, unavailable), true)
})

test("monotonic publication deadline fences held bodies and expiry crossed during resolution", t => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  const owner = new ProjectParticipants(), stream = owner.register("principal", () => true)!
  const held = owner.admit(stream.grant.token, "principal")!
  now = 5_000
  assert.equal(held.publish({ revision: 1, refs: [ref()] }, unavailable), false)
  const crossed = owner.admit(stream.grant.token, "principal")!
  assert.equal(crossed.publish({ revision: 1, refs: [{ ...ref("A", "/same"), workspaceId: "same" }] }, () => {
    now = 10_001; return { serverId: "A", directory: "/same", owner: {} }
  }), false)
  assert.equal(owner.admit(stream.grant.token, "principal")!.publish({ revision: 2, refs: [ref()] }, unavailable), true)
  assert.equal(owner.snapshot("A").owners[0]!.observation, "declared")
})

test("unreadable principals/bindings fail closed without exposing callback errors", () => {
  const owner = new ProjectParticipants(); let fail = false
  const stream = owner.register("principal", () => { if (fail) throw new Error("PRIVATE_PRINCIPAL_ERROR"); return true })!
  const value = { revision: 1, refs: [{ ...ref("A", "/same"), workspaceId: "same" }] }
  assert.equal(owner.admit(stream.grant.token, "principal")!.publish(value, () => { throw new Error("PRIVATE_BINDING_ERROR") }), false)
  assert.equal(owner.admit(stream.grant.token, "principal")!.publish({ revision: 2, refs: [ref()] }, unavailable), true)
  const captured = owner.snapshot("A")
  fail = true
  assert.equal(owner.isCurrent(captured.receipt), false)
  fail = false
  assert.equal(owner.admit(stream.grant.token, "principal"), undefined)
  assert.doesNotMatch(JSON.stringify(owner.snapshot("A")), /PRIVATE|principal/)
  const fresh = owner.register("principal", () => true)!
  assert.equal(owner.admit(fresh.grant.token, "principal")!.publish({ revision: 1, refs: [ref()] }, unavailable), true)
})
