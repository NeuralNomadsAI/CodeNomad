import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { RemoteControlOwnerLease } from "./owner-lease"

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-remote-lease-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, "remote-control.owner")
  const alive = new Set<number>()
  return { file, alive, lease: (pid: number) => new RemoteControlOwnerLease(file, pid, (candidate) => alive.has(candidate)) }
}

test("a live backend keeps the lease from another one", (t) => {
  const { alive, lease } = fixture(t)
  alive.add(100).add(200)
  assert.equal(lease(100).tryAcquire(), true)
  assert.equal(lease(100).tryAcquire(), true)
  assert.equal(lease(200).tryAcquire(), false)
})

test("a crashed owner's lease is replaced", (t) => {
  const { file, alive, lease } = fixture(t)
  alive.add(200)
  assert.equal(lease(100).tryAcquire(), true)
  assert.equal(lease(200).tryAcquire(), true)
  assert.equal(fs.readFileSync(file, "utf8"), "200")
})

test("an unreadable lease is replaced", (t) => {
  const { file, lease } = fixture(t)
  fs.writeFileSync(file, "not a pid")
  assert.equal(lease(100).tryAcquire(), true)
})

test("only the owner releases the lease", (t) => {
  const { file, alive, lease } = fixture(t)
  alive.add(100).add(200)
  lease(100).tryAcquire()
  lease(200).release()
  assert.equal(fs.existsSync(file), true)
  lease(100).release()
  assert.equal(fs.existsSync(file), false)
  assert.equal(lease(200).tryAcquire(), true)
})
