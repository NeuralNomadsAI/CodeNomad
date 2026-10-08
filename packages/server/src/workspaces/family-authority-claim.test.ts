import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { once } from "node:events"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { FamilyAuthorityStore, readFamilyAuthorityIdentity, readFamilyAuthorityPlacementSync } from "./family-authority-claim"
import type { StoragePolicy } from "../host-lifetime/storage"

// Explicit private filesystem fixture adapter, NOT proof of Windows ACLs. The
// product path always defaults to native privateStorage, never this test policy.
const policy: StoragePolicy = { verify: async (file, directory) => {
  const stat = await lstat(file)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("unsafe")
} }

async function fixture() {
  const temporary = path.join(os.tmpdir(), "opencode")
  await mkdir(temporary, { recursive: true })
  const root = await realpath(await mkdtemp(path.join(temporary, "family-claim-")))
  const storeRoot = path.join(root, "claims")
  const family = path.join(root, "physical-common")
  await mkdir(storeRoot, { mode: 0o700 })
  await mkdir(family)
  const identity = process.platform === "win32" ? family.toLowerCase() : family
  const store = (profileKey = "profile", executionHostKey = "host", override = policy) => new FamilyAuthorityStore({
    root: storeRoot, profileKey, executionHostKey, policy: override,
  })
  return { root, storeRoot, identity, store, marker: async () => path.join(storeRoot, (await readdir(storeRoot))[0], "owner.json") }
}

test("family exclusion is independent of profile/daemon host and retained until the last reference", async () => {
  const f = await fixture()
  const store = f.store()
  const [first, second] = await Promise.all([store.acquire(f.identity), store.acquire(f.identity)])
  await first.assertCurrent()
  for (const competing of [f.store(), f.store("other-profile"), f.store("profile", "other-daemon-host")]) {
    await assert.rejects(competing.acquire(f.identity), /family-owner-conflict/)
  }
  await first.release()
  await assert.rejects(first.assertCurrent(), /family-claim-lost/)
  await second.assertCurrent()
  await assert.rejects(f.store().acquire(f.identity), /family-owner-conflict/)
  await second.release()
  await second.release()
  const replacement = await f.store("other-profile").acquire(f.identity)
  await replacement.release()
  assert.deepEqual(await readdir(f.storeRoot), [])
})

test("changed, oversized or malformed markers are preserved and never release another owner's capability", async () => {
  for (const kind of ["changed", "oversized", "malformed"] as const) {
    const f = await fixture()
    const claim = await f.store().acquire(f.identity)
    const marker = await f.marker()
    const original = await readFile(marker, "utf8")
    const content = kind === "changed" ? JSON.stringify({ ...JSON.parse(original), profileKey: "foreign" })
      : kind === "oversized" ? "x".repeat(8193) : "invalid PRIVATE content"
    await writeFile(marker, content)
    await assert.rejects(claim.assertCurrent(), error => error instanceof Error && error.message === "family-claim-lost")
    await assert.rejects(claim.release(), /family-claim-lost/)
    assert.equal(await readFile(marker, "utf8"), content)
    await assert.rejects(f.store().acquire(f.identity), /family-owner-conflict/)
    await writeFile(marker, original)
    await claim.release()
  }
})

test("unknown owner identity, unavailable privacy and partial publication fail closed without exposure", async () => {
  const f = await fixture()
  const unknown = new FamilyAuthorityStore({ root: f.storeRoot, profileKey: "profile", executionHostKey: "host", policy,
    lookup: async () => ({ state: "unknown" }) })
  await assert.rejects(unknown.acquire(f.identity), /family-owner-unknown/)
  const unavailable = f.store("profile", "host", { verify: async () => { throw new Error("PRIVATE ACL PATH") } })
  await assert.rejects(unavailable.acquire(f.identity), error => error instanceof Error && error.message === "family-store-unavailable")
  assert.deepEqual(await readdir(f.storeRoot), [])
  const partial = f.store("profile", "host", { verify: async (file, directory) => {
    await policy.verify(file, directory)
    if (file.endsWith(".owner")) throw new Error("PRIVATE partial publication")
  } })
  await assert.rejects(partial.acquire(f.identity), error => error instanceof Error && error.message === "family-claim-unavailable")
  await assert.rejects(f.store().acquire(f.identity), /family-owner-conflict/)
  assert.equal((await readdir(f.storeRoot)).length, 1, "an incomplete claim is not silently stolen")
})

test("release refuses unexpected files before removing its owned marker and supports exact retry", async () => {
  const f = await fixture()
  const claim = await f.store().acquire(f.identity)
  const marker = await f.marker()
  const extra = path.join(path.dirname(marker), "unfamiliar.txt")
  await writeFile(extra, "Keep this file")
  await assert.rejects(claim.release(), /family-release-unconfirmed/)
  await claim.assertCurrent()
  assert.equal(await readFile(extra, "utf8"), "Keep this file")
  await unlink(extra) // Only our own exact private test file.
  await claim.release()
})

test("a crashed private owner does not authorize PID/TTL-based takeover", { timeout: 15_000 }, async t => {
  const f = await fixture()
  const module = new URL("./family-authority-claim.ts", import.meta.url).href
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { FamilyAuthorityStore } from ${JSON.stringify(module)}
    import { lstat } from 'node:fs/promises'
    const policy = { verify: async (file, directory) => {
      const stat = await lstat(file)
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('unsafe')
    } }
    const store = new FamilyAuthorityStore({ ...${JSON.stringify({ root: f.storeRoot, profileKey: "child-profile", executionHostKey: "host" })}, policy })
    await store.acquire(${JSON.stringify(f.identity)})
    process.stdout.write('CLAIMED\\n')
    process.stdin.resume()
    process.stdin.on('data', () => process.exit(1))
  `], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  let output = ""
  let errors = ""
  child.stderr!.on("data", bytes => { errors += String(bytes) })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", bytes => { output += String(bytes); if (output.includes("CLAIMED\n")) resolve() })
    child.once("error", reject)
    child.once("exit", () => reject(new Error(`Private owner exited before readiness: ${errors}`)))
  })
  await assert.rejects(f.store().acquire(f.identity), /family-owner-conflict/)
  const exit = once(child, "exit")
  child.stdin!.write("crash")
  await exit
  await assert.rejects(f.store().acquire(f.identity), /family-owner-conflict/)
  assert.equal((await readdir(f.storeRoot)).length, 1)
})

test("registered linked checkouts share the physical Git common directory; non-Git roots cannot infer a family", async () => {
  const f = await fixture()
  const repo = path.join(f.root, "repo")
  const worktree = path.join(f.root, "linked")
  await mkdir(repo)
  const git = (args: string[], directory = repo) => execFileSync("git", ["-C", directory, ...args], { windowsHide: true, stdio: "pipe" })
  git(["-c", "init.defaultBranch=fixture", "init"])
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Private fixture"])
  git(["worktree", "add", "--detach", worktree])
  assert.equal(await readFamilyAuthorityIdentity(repo), await readFamilyAuthorityIdentity(worktree))
  const nested = path.join(worktree, "packages", "server")
  await mkdir(nested, { recursive: true })
  const placement = readFamilyAuthorityPlacementSync(nested)
  assert.equal(placement.family, await readFamilyAuthorityIdentity(repo))
  const checkout = await realpath(worktree)
  assert.equal(placement.checkout, process.platform === "win32" ? path.normalize(checkout).toLowerCase() : path.normalize(checkout))
  await assert.rejects(readFamilyAuthorityIdentity(f.root), error => error instanceof Error && error.message === "family-identity-unavailable")
})
