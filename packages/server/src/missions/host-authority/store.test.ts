import assert from "node:assert/strict"
import test from "node:test"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { authenticateAuthorityIntent, snapshotAuthoritySigner, authorityDigest, authoritySignerDigest } from "../authority-protocol"
import { ProtectedHostAuthority } from "./store"
import { fixture } from "./test-fixture"

test("explicit prepare stores private generated key but cannot qualify or sign without native parent bridge", async t => {
  const f = await fixture({ bridge: false }); t.after(f.cleanup)
  const state = await f.prepare()
  assert.equal(state.state, "staged"); assert.equal(state.signer, null); assert.equal(state.mirror, null)
  assert.equal(state.pendingDigest, null); assert.deepEqual(await f.host.readSigners(), [])
  assert.ok(Object.isFrozen(state.binding)); assert.ok(Object.isFrozen(state.binding.roots))
  const raw = await readFile(f.recordFile, "utf8")
  assert.ok(raw.includes("privateKey")); assert.ok(!JSON.stringify(state).includes("privateKey"))
  await assert.rejects(f.host.sign(f.request, await f.body("adopt", {}), state.revision), /native-qualification-unavailable/)
  assert.equal(await readFile(f.recordFile, "utf8"), raw)
  assert.throws(() => f.host.assertManagedIncarnation(), /native-qualification-unavailable/)
  const reload = new ProtectedHostAuthority(f.files, f.admissions)
  assert.equal((await reload.read())!.state, "staged"); assert.deepEqual(await reload.readSigners(), [])
})

test("genuine core adoption and separate Play; host staging blocks grants until fresh native completion", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  await f.execute(await f.body("adopt", {}))
  let snapshot = (await f.host.read())!
  assert.equal(snapshot.state, "qualified"); assert.equal(snapshot.mirror!.sendsEnabled, false)
  await assert.rejects(f.host.assertHostGrant(snapshot.mirror!), /host-grant-disabled/)
  const signer = snapshot.signer!
  assert.equal(f.host.assertSignerCurrent(signer), true)
  assert.equal(f.host.assertSignerCurrent(snapshotAuthoritySigner((await f.host.readSigners())[0])), true)
  await f.execute(await f.body("lifecycle", { action: "start" }))
  snapshot = (await f.host.read())!
  assert.equal(snapshot.mirror!.sendsEnabled, true)
  await f.host.assertHostGrant(snapshot.mirror!)
  assert.equal(f.host.assertHostGrantCurrent(snapshot.mirror!), true)
  assert.equal(f.nativeReads(), 4)
  const before = snapshot.revision
  await f.host.read(); await f.host.readSigners()
  assert.equal((await f.host.read())!.revision, before, "reads never stage/adopt/start")
  const reload = new ProtectedHostAuthority(f.files, f.admissions)
  assert.equal((await reload.read())!.state, "staged"); assert.deepEqual(await reload.readSigners(), [])
  assert.throws(() => reload.assertManagedIncarnation(), /native-qualification-unavailable/)
})

test("a signature is domain-separated product allowlist only, never arbitrary driver input or caller keys", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  const before = (await f.host.read())!
  const body = await f.body("adopt", {})
  for (const changed of [{ ...body, method: "invoke", payload: { tool: "delegate" } }, { ...body, privateKey: "caller" },
    { ...body, profileID: "foreign" }, { ...body, namespace: randomUUID() }]) {
    await assert.rejects(f.host.sign(f.request, changed, before.revision))
    assert.equal((await f.host.read())!.revision, before.revision)
  }
  const signed = await f.host.sign(f.request, body, before.revision)
  const signers = await f.host.readSigners()
  assert.equal(authenticateAuthorityIntent(signed, signers).body.requestID, body.requestID)
  assert(!JSON.stringify(signed).includes("privateKey")); assert(Object.isFrozen(signed.body))
  assert.equal((await f.host.read())!.pendingDigest, authorityDigest(body))
  await assert.rejects(f.host.sign(f.request, body, (await f.host.read())!.revision), /native-operation-pending/)
  assert.equal((await f.host.read())!.pendingDigest, authorityDigest(body))
})

test("real host CAS serializes competing stores; stale and orphaned claims never overwrite state", async t => {
  const f = await fixture(); t.after(f.cleanup)
  const competitor = new ProtectedHostAuthority(f.files, f.admissions)
  const attempts = await Promise.allSettled([f.prepare(), competitor.prepare(f.request, f.target, null)])
  assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1)
  assert.equal((await f.host.read())!.revision, 1)
  const before = await readFile(f.recordFile, "utf8")
  await assert.rejects(f.host.revoke(f.request, 0), /revision-conflict/)
  assert.equal(await readFile(f.recordFile, "utf8"), before)
  await mkdir(f.lockDirectory)
  await assert.rejects(f.host.revoke(f.request, 1), /exclusive-claim-unavailable/)
  assert.throws(() => f.host.assertManagedIncarnation(), /writer-pending/)
  assert.equal(await readFile(f.recordFile, "utf8"), before)
})

test("revocation is durable before any native effect and ignores missing qualification or pending completion", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  await f.execute(await f.body("adopt", {})); await f.execute(await f.body("lifecycle", { action: "start" }))
  const active = (await f.host.read())!
  const stop = await f.body("lifecycle", { action: "stop" })
  await f.host.sign(f.request, stop, active.revision)
  const staged = (await f.host.read())!
  assert.equal(staged.mirror!.state, "revoked"); assert.equal(staged.mirror!.sendsEnabled, false)
  assert(staged.pendingDigest)
  assert.throws(() => f.host.assertHostGrantCurrent(active.mirror!), /host-grant-disabled/)
  // No native execute occurred: native remains active; protected host denial is
  // not an interruption/completion receipt or permission to replay pending Stop.
  assert.equal((await f.core.state(f.target.missionID)).grant!.sendsEnabled, true)
  f.loseNative()
  const revoked = await f.host.revoke(f.request, staged.revision)
  assert.equal(revoked.state, "revoked"); assert.equal(revoked.pendingDigest, staged.pendingDigest)
  assert.deepEqual(await f.host.readSigners(), [])
  assert.throws(() => f.host.assertHostGrantCurrent(active.mirror!), /native-qualification-unavailable/)
  await assert.rejects(f.host.sign(f.request, stop, revoked.revision), /signer-revoked/)
})

test("native proof must bind nonce/scope/key generation and exclude all observed legacy writers", async t => {
  for (const fault of [
    (value: any) => { value.nonce = randomUUID() },
    (value: any) => { value.descriptor.executionHost = "other" },
    (value: any) => { value.writer.namespace = randomUUID() },
    (value: any) => { value.provisioningGeneration = randomUUID() },
    (value: any) => { value.backendOwner.pid = process.pid + 1 },
    (value: any) => { value.signerDigest = "0".repeat(64) },
    (value: any) => { value.quiescence.remainingLegacyWriterIDs = ["live-old-writer"] },
  ]) {
    const f = await fixture(); t.after(f.cleanup); await f.prepare()
    const before = await readFile(f.recordFile, "utf8")
    f.observationFault(fault)
    await assert.rejects(f.host.sign(f.request, await f.body("adopt", {}), 1))
    assert.equal(await readFile(f.recordFile, "utf8"), before)
  }
})

test("literal true and existing AuthManager/owned fences recheck after native preparation", async t => {
  for (const fault of ["auth", "ownership", "native", "async"] as const) {
    const f = await fixture(); t.after(f.cleanup); await f.prepare()
    const before = await readFile(f.recordFile, "utf8")
    f.afterHandshake(() => {
      if (fault === "auth") f.loseAuth()
      if (fault === "ownership") f.loseOwnership()
      if (fault === "native") f.loseNative()
      if (fault === "async") f.nativeBridge.assertCurrent = (() => Promise.resolve(true)) as never
    })
    await assert.rejects(f.host.sign(f.request, await f.body("adopt", {}), 1))
    assert.equal(await readFile(f.recordFile, "utf8"), before)
  }
  const disabled = await fixture(); t.after(disabled.cleanup); disabled.disableAuth()
  await assert.rejects(disabled.prepare(), /human-auth-required/)
})

test("malformed or lost key/installation files are never treated as a new installation", async t => {
  for (const damage of ["json", "key", "lost", "marker"] as const) {
    const f = await fixture(); t.after(f.cleanup); await f.prepare()
    if (damage === "json") await writeFile(f.recordFile, "{corrupt")
    if (damage === "key") {
      const value = JSON.parse(await readFile(f.recordFile, "utf8")); value.privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
      await writeFile(f.recordFile, JSON.stringify(value))
    }
    if (damage === "lost") await rm(f.recordFile)
    if (damage === "marker") await writeFile(f.markerFile, JSON.stringify({ installationID: randomUUID() }))
    await assert.rejects(f.host.read())
    await assert.rejects(f.prepare())
    if (damage === "lost") await assert.rejects(readFile(f.recordFile))
  }
})

test("fresh synchronous signer fence rejects disk generation/key/scope changes and native trust loss", async t => {
  for (const damage of ["generation", "scope", "key", "native"] as const) {
    const f = await fixture(); t.after(f.cleanup); await f.prepare(); await f.execute(await f.body("adopt", {}))
    const signer = (await f.host.read())!.signer!
    if (damage === "native") f.loseNative()
    else {
      const value = JSON.parse(await readFile(f.recordFile, "utf8"))
      if (damage === "generation") value.generation = randomUUID()
      if (damage === "scope") value.descriptor.scope.configIdentity = path.join(f.profile, "moved.yaml")
      if (damage === "key") value.publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64")
      await writeFile(f.recordFile, JSON.stringify(value))
    }
    assert.throws(() => f.host.assertSignerCurrent(signer))
    assert.throws(() => f.host.assertManagedIncarnation())
  }
})

test("metadata staged key cannot be copied to a moved profile/private root or silently rotated", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  const before = (await f.host.read())!
  await assert.rejects(f.host.prepare(f.request, f.target, before.revision), /rotation-unqualified/)
  const moved = path.join(f.root, "moved-profile")
  await rename(f.profile, moved)
  await assert.rejects(f.host.read(), /private-storage-unavailable/)
  assert.throws(() => f.host.assertManagedIncarnation())
})

test("explicit qualified rotation follows completed native revoke and local denial; new key needs separate re-adoption/Play", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  await f.execute(await f.body("adopt", {})); await f.execute(await f.body("lifecycle", { action: "start" }))
  const original = (await f.host.read())!
  await f.execute(await f.body("revoke", {}))
  const revokedNative = (await f.host.read())!
  assert.equal(revokedNative.mirror!.state, "revoked")
  const local = await f.host.revoke(f.request, revokedNative.revision)
  const rotated = await f.host.prepare(f.request, f.target, local.revision)
  assert.notEqual(rotated.binding.keyID, original.binding.keyID)
  assert.notEqual(rotated.generation, original.generation)
  assert.equal(rotated.state, "staged"); assert.equal(rotated.epoch, 1); assert.equal(rotated.mirror, null)
  assert.deepEqual(await f.host.readSigners(), [])
  assert.throws(() => f.host.assertSignerCurrent(original.signer!))
  await f.execute(await f.body("adopt", {}))
  const adopted = (await f.host.read())!
  assert.equal(adopted.epoch, 2); assert.equal(adopted.mirror!.sendsEnabled, false)
  assert.throws(() => f.host.assertSignerCurrent(original.signer!), /signer-changed/)
})

test("native mirror acceptance re-reads revision/evidence twice; corrupt generation/ACK never clears pending host denial", async t => {
  for (const mismatch of ["generation", "digest", "uncompleted", "changed"] as const) {
    const f = await fixture(); t.after(f.cleanup); await f.prepare()
    const body = await f.body("adopt", {})
    const signed = await f.host.sign(f.request, body, 1)
    const signer = (await f.host.read())!.signer!
    const result = await f.core.execute(signed, { expectedSigner: signer, apply: async () => { throw new Error("never for adopt") } }, new AbortController().signal)
    const nativeState = await f.core.state(f.target.missionID)
    const observation = { operation: structuredClone(result), revision: 1, terminal: nativeState.terminal, pendingRequestIDs: [] as string[] }
    if (mismatch === "generation") observation.operation.receipt.provisioningGeneration = randomUUID()
    if (mismatch === "digest") observation.operation.receipt.digest = "0".repeat(64)
    if (mismatch === "uncompleted") delete observation.operation.receipt.completion
    f.setObservation(observation)
    if (mismatch === "changed") f.betweenNativeReads(() => { observation.revision++ })
    const before = (await f.host.read())!
    await assert.rejects(f.host.accept(f.request, before.pendingDigest!, before.revision))
    const after = (await f.host.read())!
    assert.equal(after.pendingDigest, before.pendingDigest)
    assert.equal(after.revision, before.revision)
    assert.equal(after.mirror, null)
  }
})

test("latest protected scope/epoch/ownership cannot be substituted at final grant boundary", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  await f.execute(await f.body("adopt", {})); await f.execute(await f.body("lifecycle", { action: "start" }))
  const state = (await f.host.read())!, grant = state.mirror!
  for (const changed of [{ ...grant, epoch: grant.epoch + 1 }, { ...grant, profileID: "other" }, { ...grant, namespace: randomUUID() },
    { ...grant, roots: [{ mode: "directory-only" as const, directory: path.join(f.project, "child") }] }]) {
    assert.throws(() => f.host.assertHostGrantCurrent(changed))
  }
  f.nativeBridge.assertCurrent = (() => ({ then() {} })) as never
  assert.throws(() => f.host.assertHostGrantCurrent(grant), /policy-unqualified/)
})

test("signed Stop supersedes ambiguous Play without replay, keeps the host/native grant disabled and accepts only its original receipt", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare(); await f.execute(await f.body("adopt", {}))
  const play = await f.body("lifecycle", { action: "start" })
  const signed = await f.host.sign(f.request, play, (await f.host.read())!.revision)
  const signer = (await f.host.read())!.signer!
  let attempts = 0
  await assert.rejects(f.core.execute(signed, { expectedSigner: signer, apply: async () => { attempts++; throw new Error("lost native effect ACK") } }, new AbortController().signal))
  await f.core.execute(signed, { expectedSigner: signer, apply: async () => { attempts++; return { missionID: f.target.missionID } } }, new AbortController().signal)
  assert.equal(attempts, 1)
  assert((await f.core.state(f.target.missionID)).pendingRequestIDs.includes(play.requestID))
  await f.execute(await f.body("lifecycle", { action: "stop" }))
  const stopped = (await f.host.read())!
  assert.equal(stopped.pendingDigest, null)
  assert.equal(stopped.mirror!.state, "revoked"); assert.equal(stopped.mirror!.sendsEnabled, false)
  assert((await f.core.state(f.target.missionID)).pendingRequestIDs.includes(play.requestID), "old ambiguity remains native evidence, never a replay runner")
  assert.throws(() => f.host.assertHostGrantCurrent(stopped.mirror!), /host-grant-disabled/)
})

test("generation/key substitution during private handshake cannot reuse approval or overwrite the changed state", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  const body = await f.body("adopt", {})
  let changed = ""
  f.afterHandshake(async () => {
    const raw = JSON.parse(await readFile(f.recordFile, "utf8")), replacement = generateKeyPairSync("ed25519")
    raw.generation = randomUUID()
    raw.privateKey = replacement.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    raw.publicKey = replacement.publicKey.export({ format: "der", type: "spki" }).toString("base64")
    raw.signerDigest = authoritySignerDigest(replacement.publicKey)
    changed = JSON.stringify(raw)
    await writeFile(f.recordFile, changed)
  })
  await assert.rejects(f.host.sign(f.request, body, 1), /signer-changed/)
  assert.equal(await readFile(f.recordFile, "utf8"), changed)
  assert.equal((await f.host.read())!.pendingDigest, null)
})
