import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { FamilyAuthorityStore, readFamilyAuthorityIdentity } from "./family-authority-claim"
import { assertSynchronousAuthorityGuard } from "../missions/authority-synchronous"

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(nativePrivacy = false) {
  const base = nativePrivacy && process.platform === "win32" ? process.env.LOCALAPPDATA : path.join(os.tmpdir(), "opencode")
  assert(base)
  const root = await realpath(await mkdtemp(path.join(base, "family-sync-")))
  const registry = path.join(root, "claims"), repo = path.join(root, "repo")
  await mkdir(registry, { mode: 0o700 })
  execFileSync("git", ["init", "--quiet", repo], { windowsHide: true, stdio: "pipe" })
  const family = await readFamilyAuthorityIdentity(repo)
  const policy = { verifySync(file: string, directory: boolean) {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw Error("unsafe")
  }, async verify(file: string, directory: boolean) { this.verifySync(file, directory) } }
  const store = new FamilyAuthorityStore({ root: registry, profileKey: "fixture", executionHostKey: "fixture",
    policy, lookup: async () => ({ state: "live", startIdentity: "isolated-process" }) })
  return { root, registry, family, policy, store, marker: async () => path.join(registry, (await readdir(registry))[0], "owner.json") }
}

test("fresh native guard is literal true; async guard remains rejected and retained references stay independent", async () => {
  const f = await fixture(), pending: Promise<unknown>[] = []
  try {
    const first = await f.store.acquire(f.family), second = await f.store.acquire(f.family)
    assert.equal(assertSynchronousAuthorityGuard(first.assertCurrentSync, "policy-unqualified"), true)
    const oldGuard = () => { const read = first.assertCurrent(); pending.push(read); return read }
    assert.throws(() => assertSynchronousAuthorityGuard(oldGuard as never, "policy-unqualified"), /policy-unqualified/)
    await first.assertCurrent() // Drain the old callback's queued read, not an approval cache.
    const releasing = first.release(); pending.push(releasing)
    assert.throws(first.assertCurrentSync, /family-claim-lost/)
    assert.throws(second.assertCurrentSync, /family-claim-lost/)
    await releasing
    assert.throws(first.assertCurrentSync, /family-claim-lost/)
    assert.equal(second.assertCurrentSync(), true)
    await second.release()
  } finally { await Promise.allSettled(pending); await rm(f.root, { recursive: true, force: true }) }
})

test("fresh descriptor, marker bytes, root aliases and unconfirmed synchronous privacy fail closed", async () => {
  const f = await fixture()
  try {
    const claim = await f.store.acquire(f.family), file = await f.marker(), saved = file + ".owned-withheld"
    const bytes = readFileSync(file)
    for (const kind of ["absent", "same-bytes-replaced"] as const) {
      renameSync(file, saved)
      try {
        if (kind === "same-bytes-replaced") writeFileSync(file, bytes)
        assert.throws(claim.assertCurrentSync, /family-claim-lost/)
      } finally { if (kind === "same-bytes-replaced") unlinkSync(file); renameSync(saved, file) }
    }
    for (const bytesChanged of [Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), token: "0".repeat(64) })),
      Buffer.from([0xff]), Buffer.alloc(8193)]) {
      try { writeFileSync(file, bytesChanged); assert.throws(claim.assertCurrentSync, /family-claim-lost/) }
      finally { writeFileSync(file, bytes) }
    }
    const verify = f.policy.verifySync
    try { f.policy.verifySync = () => { throw Error("private native detail") }; assert.throws(claim.assertCurrentSync, /family-claim-lost/) }
    finally { f.policy.verifySync = verify }
    renameSync(f.registry, f.registry + ".owned-moved")
    try {
      await symlink(f.registry + ".owned-moved", f.registry, process.platform === "win32" ? "junction" : "dir")
      assert.throws(claim.assertCurrentSync, /family-claim-lost/)
    } finally { await rm(f.registry, { force: true }); renameSync(f.registry + ".owned-moved", f.registry) }
    assert.equal(claim.assertCurrentSync(), true)
    await claim.release()
    const asyncOnly = new FamilyAuthorityStore({ root: f.registry, profileKey: "fixture", executionHostKey: "fixture",
      policy: { verify: f.policy.verify.bind(f.policy) }, lookup: async () => ({ state: "live", startIdentity: "isolated-process" }) })
    const unconfirmed = await asyncOnly.acquire(f.family)
    await unconfirmed.assertCurrent()
    assert.throws(unconfirmed.assertCurrentSync, /family-claim-lost/)
    await unconfirmed.release()
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test("queued release and reentrant privacy work revoke only their reference without altering async retries", async () => {
  const f = await fixture(), entered = gate(), resume = gate(), pending: Promise<unknown>[] = []
  let hold = false
  try {
    const first = await f.store.acquire(f.family), second = await f.store.acquire(f.family)
    const verify = f.policy.verify.bind(f.policy)
    f.policy.verify = async (file, directory) => { if (hold) { entered.resolve(); await resume.promise }; await verify(file, directory) }
    hold = true
    const reading = second.assertCurrent(); pending.push(reading)
    await entered.promise
    const releasing = first.release(); pending.push(releasing)
    assert.throws(first.assertCurrentSync, /family-claim-lost/)
    assert.throws(second.assertCurrentSync, /family-claim-lost/)
    hold = false; resume.resolve(); await reading; await releasing
    assert.equal(second.assertCurrentSync(), true)
    const extra = path.join(path.dirname(await f.marker()), "owned-extra")
    writeFileSync(extra, "own fixture")
    await assert.rejects(second.release(), /family-release-unconfirmed/)
    await second.assertCurrent() // Existing asynchronous recovery semantics are unchanged.
    assert.throws(second.assertCurrentSync, /family-claim-lost/)
    unlinkSync(extra); await second.release()
    const third = await f.store.acquire(f.family), retained = await f.store.acquire(f.family)
    let queued: Promise<void> | undefined
    const sync = f.policy.verifySync
    f.policy.verifySync = (file, directory) => { sync(file, directory); if (!queued) { queued = third.release(); pending.push(queued) } }
    assert.throws(third.assertCurrentSync, /family-claim-lost/, "reentrant release is fenced after the fresh read")
    f.policy.verifySync = sync
    await queued
    assert.equal(retained.assertCurrentSync(), true)
    await retained.release()
  } finally { hold = false; resume.resolve(); await Promise.allSettled(pending); await rm(f.root, { recursive: true, force: true }) }
})

test("default synchronous policy uses genuine native owner/privacy evidence", async () => {
  const f = await fixture(true)
  try {
    if (process.platform === "win32") {
      const script = `$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[System.Security.AccessControl.DirectorySecurity]::new(); $a.SetOwner($u); $a.SetAccessRuleProtection($true,$false); foreach($s in @($u,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}; Set-Acl -LiteralPath '${f.root.replaceAll("'", "''")}' -AclObject $a -ErrorAction Stop`
      const executable = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
      execFileSync(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { windowsHide: true, timeout: 10_000, stdio: "pipe", env: { ...process.env, PSModulePath: path.join(path.dirname(executable), "Modules") } })
    }
    const native = new FamilyAuthorityStore({ root: f.registry, profileKey: "private-native-fixture", executionHostKey: "own-process" })
    const claim = await native.acquire(f.family)
    assert.equal(assertSynchronousAuthorityGuard(claim.assertCurrentSync, "policy-unqualified"), true)
    await claim.release()
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
