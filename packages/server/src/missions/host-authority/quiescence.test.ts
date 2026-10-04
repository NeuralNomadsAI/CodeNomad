import assert from "node:assert/strict"
import test from "node:test"
import pino from "pino"
import type { FastifyRequest } from "fastify"
import type { OpenCodeClient } from "@opencode/client"
import { AuthManager } from "../../auth/manager"
import { authorityDigest } from "../authority-protocol"
import { HostAuthorityAdmissions } from "./qualification"
import { ProtectedHostAuthority } from "./store"
import { assertExplicitQuiescence, readNativeDiscoveryBoundary, type ExplicitQuiescenceEvidence } from "./quiescence"
import { fixture } from "./test-fixture"

test("old/native writers need explicit exact incarnation disposal evidence, not absence/TTL or a qualified boolean", () => {
  const value: ExplicitQuiescenceEvidence = {
    actionID: "authenticated-explicit-upgrade", discoveryRoot: "C:/private/native/config", configDigest: "a".repeat(64), inventoryDigest: "0".repeat(64),
    excludedWriterIDs: ["old"], remainingLegacyWriterIDs: [], policy: "explicit-human-quiescence-v1",
    before: [{ id: "old", incarnationID: "old-incarnation", artifactDigest: "b".repeat(64), kind: "legacy", state: "active" }],
    after: [{ id: "managed", incarnationID: "managed-incarnation", artifactDigest: "c".repeat(64), kind: "managed", state: "active" }],
    disposals: [{ registrationID: "old", incarnationID: "old-incarnation", receiptID: "native-private-disposed-receipt" }],
  }
  const seal = (evidence: ExplicitQuiescenceEvidence) => { evidence.inventoryDigest = authorityDigest({ before: evidence.before, after: evidence.after, disposals: evidence.disposals }); return evidence }
  const writer = { registrationID: "managed", incarnationID: "managed-incarnation", artifactDigest: "c".repeat(64) }
  assertExplicitQuiescence(seal(value), writer)
  for (const fault of ["missing-receipt", "wrong-incarnation", "unknown", "live-legacy", "config-digest", "inventory", "duplicate", "old-artifact"] as const) {
    const changed = structuredClone(value)
    if (fault === "missing-receipt") changed.disposals = []
    if (fault === "wrong-incarnation") changed.disposals[0].incarnationID = "different"
    if (fault === "unknown") changed.before[0].state = "unknown"
    if (fault === "live-legacy") changed.after.push(changed.before[0])
    if (fault === "inventory") changed.excludedWriterIDs = []
    if (fault === "duplicate") changed.before.push(changed.before[0])
    if (fault === "old-artifact") changed.after[0].artifactDigest = "e".repeat(64)
    seal(changed)
    if (fault === "config-digest") changed.inventoryDigest = "f".repeat(64)
    assert.throws(() => assertExplicitQuiescence(changed, writer))
  }
  const relabeled = structuredClone(value)
  relabeled.before = [{ ...relabeled.after[0], kind: "legacy", artifactDigest: "b".repeat(64) }]
  relabeled.excludedWriterIDs = ["managed"]
  relabeled.disposals = [{ registrationID: "managed", incarnationID: "managed-incarnation", receiptID: "cannot-be-active-and-disposed" }]
  assert.throws(() => assertExplicitQuiescence(seal(relabeled), writer), /writer-incarnation-reused/)
})

test("discovery reads connected native config twice, never caller environment or implicit lifecycle", async () => {
  let calls = 0
  const source = [{ type: "directory", path: "C:/native/global" }, { type: "directory", path: "C:/native/project" }]
  const client = { config: { async get() { calls++; return structuredClone(source) } } } as unknown as Pick<OpenCodeClient, "config">
  const value = await readNativeDiscoveryBoundary(client, () => true, new AbortController().signal)
  assert.equal(value.globalDirectory, source[0].path); assert.equal(value.configDigest, authorityDigest(source)); assert.equal(calls, 2)
  const changed = { config: { async get() { calls++; return [{ type: "directory", path: `C:/native/config-${calls}` }] } } } as unknown as Pick<OpenCodeClient, "config">
  await assert.rejects(readNativeDiscoveryBoundary(changed, () => true, new AbortController().signal), /native-config-changed/)
  await assert.rejects(readNativeDiscoveryBoundary(client, (() => Promise.resolve(true)) as never, new AbortController().signal), /policy-unqualified/)
})

test("existing real AuthManager cookie session is the only human gate; private module creates no second HTTP auth store", async t => {
  const f = await fixture({ bridge: false }); t.after(f.cleanup)
  const auth = new AuthManager({ configPath: f.descriptor.scope.configIdentity, username: "fixture-human", password: "isolated-fixture-password", generateToken: false }, pino({ level: "silent" }))
  const admissions = new HostAuthorityAdmissions(auth, { async withOwned(_binding, operation) { return operation(() => true) } }, f.descriptor)
  const host = new ProtectedHostAuthority(f.files, admissions)
  await assert.rejects(host.prepare({ headers: {} } as FastifyRequest, f.target, null), /human-auth-required/)
  const session = auth.createSession("fixture-human")
  const request = { headers: { cookie: `${auth.getCookieName()}=${session.id}` } } as FastifyRequest
  const snapshot = await host.prepare(request, f.target, null)
  assert.equal(snapshot.state, "staged")
  await assert.rejects(host.sign(request, await f.body("adopt", {}), snapshot.revision), /native-qualification-unavailable/)
})

test("config discovery changing across proof preparation cannot publish an anchor/signature", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  let reads = 0
  f.nativeBridge.readDiscoveryBoundary = async () => ({ globalDirectory: "C:/other-config", configDigest: (++reads === 1 ? "a" : "b").repeat(64) })
  await assert.rejects(f.host.sign(f.request, await f.body("adopt", {}), 1), /native-discovery-changed/)
  assert.equal((await f.host.read())!.state, "staged")
  assert.equal((await f.host.read())!.pendingDigest, null)
})
