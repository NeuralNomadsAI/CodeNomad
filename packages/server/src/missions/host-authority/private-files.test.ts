import assert from "node:assert/strict"
import test from "node:test"
import { copyFile, link, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { privateStorage } from "../../host-lifetime/storage"
import { canonicalScope } from "../../host-lifetime/protocol"
import { ProtectedAuthorityFiles, verifyPrivateSync } from "./private-files"
import { ProtectedHostAuthority } from "./store"
import { fixture, structuralTestPolicy } from "./test-fixture"

test("default native privacy policy is reused, not a product permissive test override", async t => {
  const f = await fixture(); t.after(f.cleanup)
  let asyncPrivate = true, syncPrivate = true
  try { await privateStorage.verify(f.storage, true) } catch { asyncPrivate = false }
  try { verifyPrivateSync(f.storage, true) } catch { syncPrivate = false }
  assert.equal(syncPrivate, asyncPrivate, "synchronous fence uses the same native DACL/UID policy")
  const files = new ProtectedAuthorityFiles(f.storage, f.descriptor)
  const host = new ProtectedHostAuthority(files, f.admissions)
  if (asyncPrivate) {
    const prepared = await host.prepare(f.request, f.target, null)
    assert.equal(prepared.state, "staged")
    assert.deepEqual(await host.readSigners(), [])
  } else {
    await assert.rejects(host.prepare(f.request, f.target, null), /private-storage-unavailable/)
    await assert.rejects(readFile(path.join(files.directory, "missions-authority.json")))
    t.diagnostic("Native policy refused this isolated temp ancestor; fixture does not relax it")
  }
})

test("a fresh privacy failure after preparation/signing fences every protected signer/grant read", async t => {
  let privateNow = true
  const f = await fixture({ policy: {
    async verify(file, directory) { if (!privateNow) throw new Error("DACL changed"); await structuralTestPolicy.verify(file, directory) },
    verifySync(file, directory) { if (!privateNow) throw new Error("DACL changed"); structuralTestPolicy.verifySync(file, directory) },
  } }); t.after(f.cleanup)
  await f.prepare(); await f.execute(await f.body("adopt", {}))
  const signer = (await f.host.read())!.signer!
  privateNow = false
  await assert.rejects(f.host.read())
  assert.throws(() => f.host.assertSignerCurrent(signer))
  assert.throws(() => f.host.assertManagedIncarnation())
})

test("reparse ancestors and multiply linked files are never followed or overwritten", async t => {
  for (const kind of ["hardlink", "junction"] as const) {
    const f = await fixture(); t.after(f.cleanup); await f.prepare()
    const before = await readFile(f.recordFile, "utf8")
    if (kind === "hardlink") await link(f.recordFile, path.join(f.root, "other-link"))
    else {
      const moved = path.join(f.root, "relocated-private")
      await rename(f.storage, moved)
      await symlink(moved, f.storage, process.platform === "win32" ? "junction" : "dir")
    }
    await assert.rejects(f.host.read())
    await assert.rejects(f.host.revoke(f.request, 1))
    assert.equal(await readFile(f.recordFile, "utf8"), before)
  }
})

test("capacity keeps ordinary host staging bounded and preserves a constant-size durable denial", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  // INTERNAL file-engine resource regression, not native ownership qualification:
  // no fake proof is used and no signature, grant or effect is enabled here.
  const roots = Array.from({ length: 25 }, (_, index) => ({ mode: "git" as const,
    directory: `/${index}/${"x".repeat(2800)}`, family: "physical-family", checkout: "physical-checkout" }))
  const grown = await f.files.cas(1, async current => {
    const doc = structuredClone(current!)
    doc.manifest.roots = roots; doc.revision++
    return doc
  }, () => {})
  const before = await readFile(f.recordFile, "utf8")
  await assert.rejects(f.files.cas(2, async current => {
    const doc = structuredClone(current!)
    const body = { ...doc.manifest, version: 1 as const, policy: "codenomad.missions.authority/signed-v1" as const, epoch: 0,
      expectedRevision: 1, requestID: "bounded-update", method: "update" as const, payload: { objective: "x".repeat(20_000), notes: "y".repeat(20_000) } }
    const { authorityDigest } = await import("../authority-protocol")
    doc.pending = { body, digest: authorityDigest(body) }; doc.revision++
    return doc
  }, () => {}), /capacity/)
  assert.equal(await readFile(f.recordFile, "utf8"), before)
  const denied = await f.files.cas(grown.revision, async current => ({ ...current!, revoked: true, revision: current!.revision + 1 }), () => {}, false, true)
  assert.equal(denied.revoked, true)
  assert.equal((await f.files.read())!.revoked, true)
})

test("unknown existing private file is never replaced by initial key preparation", async t => {
  const f = await fixture(); t.after(f.cleanup)
  await mkdir(f.files.directory)
  await writeFile(f.recordFile, "unknown-owned-file")
  await assert.rejects(f.prepare())
  assert.equal(await readFile(f.recordFile, "utf8"), "unknown-owned-file")
})

test("copied key/marker pair does not acquire another profile or moved private storage identity", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  const otherProfile = path.join(f.root, "other-profile"), otherStorage = path.join(f.root, "other-private")
  await Promise.all([otherProfile, otherStorage].map(value => mkdir(value)))
  const otherDescriptor = { ...f.descriptor, scope: canonicalScope("test", path.join(otherProfile, "config.yaml"), f.root, f.root),
    physicalProfile: process.platform === "win32" ? otherProfile.toLowerCase() : otherProfile }
  for (const files of [new ProtectedAuthorityFiles(f.storage, otherDescriptor, structuralTestPolicy),
    new ProtectedAuthorityFiles(otherStorage, f.descriptor, structuralTestPolicy)]) {
    await mkdir(files.directory)
    await copyFile(f.recordFile, path.join(files.directory, "missions-authority.json"))
    await copyFile(f.markerFile, path.join(files.directory, "missions-authority.identity"))
    await assert.rejects(files.read(), /profile-moved/)
    assert.throws(() => files.readSync(), /profile-moved/)
  }
})
