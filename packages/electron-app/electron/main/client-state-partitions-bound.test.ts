import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { syncBuiltinESMExports } from "node:module"
import { ClientStatePartitionStore } from "./client-state-partitions"
import { ClientStateManager } from "./client-state"
import { DesktopAttachments } from "./desktop-attachments"
import { LocalWindowRegistry } from "./local-window-registry"
import vector from "./client-state-attachment-vector.json"

const limit = 1024 * 1024
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex")

test("verified partitions bound real reads before retain/hash/concat and close every handle", async t => {
  const root = mkdtempSync(join(process.cwd(), ".tmp/partition-bound-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  mkdirSync(join(root, "partitions"))
  const store = new ClientStatePartitionStore(root)
  const open = fs.open
  let readBytes = 0, maxRead = 0, closes = 0, failRead = false
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args)
    const read = file.read.bind(file)
    const close = file.close.bind(file)
    t.mock.method(file, "read", async (buffer: Buffer, offset: number, length: number, position: number | null) => {
      maxRead = Math.max(maxRead, length)
      if (failRead) throw new Error("owned read failure")
      const result = await read(buffer, offset, length, position)
      readBytes += result.bytesRead
      return result
    })
    t.mock.method(file, "close", async () => { closes++; await close() })
    return file
  })
  syncBuiltinESMExports()
  for (const size of [0, limit, limit + 1, 16 * limit]) {
    const content = size <= limit + 1 ? "x".repeat(size) : "large"
    const key = digest(content), path = join(root, "partitions", key)
    writeFileSync(path, content)
    if (size > limit + 1) truncateSync(path, size)
    readBytes = maxRead = closes = 0
    assert.equal(await store.load(key, () => {}), size <= limit ? content : null)
    assert.ok(readBytes <= limit + 1)
    assert.ok(maxRead <= 64 * 1024)
    assert.equal(closes, 1)
    rmSync(path)
    writeFileSync(path, content)
    if (size <= limit) assert.equal(await store.load(key, () => {}), content, "fresh positive after rejection")
    rmSync(path)
  }
  const content = "été", key = digest(content), path = join(root, "partitions", key)
  writeFileSync(path, content)
  assert.equal(await store.load(key, () => {}), content)
  writeFileSync(path, "wrong hash")
  closes = 0
  assert.equal(await store.load(key, () => {}), null)
  assert.equal(closes, 1)
  writeFileSync(path, content)
  closes = 0; failRead = true
  await assert.rejects(store.load(key, () => {}), /owned read failure/)
  assert.equal(closes, 1)
  failRead = false; closes = 0
  await assert.rejects(store.load(key, () => { throw new Error("retired authority") }), /retired authority/)
  assert.equal(closes, 1)
  assert.equal(await store.load(key, () => {}), content)
})

test("partition growth after lstat is bounded; symlink/type guards and fresh reads survive", async t => {
  const root = mkdtempSync(join(process.cwd(), ".tmp/partition-growth-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const directory = join(root, "partitions")
  mkdirSync(directory)
  const content = "valid", key = digest(content), path = join(directory, key)
  const store = new ClientStatePartitionStore(root)
  writeFileSync(path, content)
  const lstat = fs.lstat
  let grow = true
  const spy = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const result = await lstat(...args)
    if (String(args[0]) === path && grow) {
      grow = false
      appendFileSync(path, "x".repeat(4 * limit))
    }
    return result
  })
  const open = fs.open
  let bytes = 0
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args), read = file.read.bind(file)
    t.mock.method(file, "read", async (buffer: Buffer, offset: number, length: number, position: number | null) => {
      const result = await read(buffer, offset, length, position)
      bytes += result.bytesRead
      return result
    })
    return file
  })
  syncBuiltinESMExports()
  assert.equal(await store.load(key, () => {}), null)
  assert.equal(bytes, limit + 1)
  spy.mock.restore()
  syncBuiltinESMExports()
  rmSync(path)
  mkdirSync(path)
  assert.equal(await store.load(key, () => {}), null)
  rmdirSync(path)
  const target = join(root, "target")
  writeFileSync(target, content)
  symlinkSync(target, path, "file")
  assert.equal(await store.load(key, () => {}), null)
  rmSync(path)
  writeFileSync(path, content)
  assert.equal(await store.load(key, () => {}), content)
  rmSync(directory, { recursive: true })
  const other = join(root, "other")
  mkdirSync(other)
  symlinkSync(other, directory, process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(store.load(key, () => {}), /Invalid client state partition directory/)
  rmSync(directory, { recursive: true })
  mkdirSync(directory)
  writeFileSync(path, content)
  assert.equal(await store.load(key, () => {}), content)
})

test("real retained owner accepts exact-limit manifest, rejects +1 and recovers without content reads", async t => {
  const root = mkdtempSync(join(process.cwd(), ".tmp/manifest-limit-"))
  mkdirSync(join(root, "partitions"))
  const original = vector.partitions[vector.root.sessionPartition as keyof typeof vector.partitions]
  const manifest = original + " ".repeat(limit - Buffer.byteLength(original))
  const key = digest(manifest)
  const keys = vector.partitionKeys.map(old => old === vector.root.sessionPartition ? key : old).sort()
  writeFileSync(join(root, "client-state.json"), JSON.stringify({ version: 2, restoreEnabled: true, protocolVersion: 1,
    snapshot: { ...vector.root, sessionPartition: key, partitionKeys: keys }, partitionKeys: keys }))
  const path = join(root, "partitions", key)
  writeFileSync(path, manifest)
  // Workspace partition is deliberately absent: metadata must only open the manifest.
  const state = new ClientStateManager(root, undefined, { crossHostElectionDirectory: join(root, "election") })
  t.after(async () => { await state.drainAndReleasePrimary(); rmSync(root, { recursive: true, force: true }) })
  const owner = new DesktopAttachments(state, new LocalWindowRegistry(() => {}))
  const first = await owner.read()
  assert.equal(first.retainedStatus, "complete")
  assert.equal(first.refs.length, 1)
  assert.equal(owner.current(first.receipt), true)
  appendFileSync(path, " ")
  const refused = await owner.read()
  assert.equal(refused.retainedStatus, "unknown")
  assert.equal(owner.current(first.receipt), false)
  writeFileSync(path, manifest)
  const fresh = await owner.read()
  assert.equal(fresh.retainedStatus, "complete")
  assert.equal(fresh.status, "unknown")
  assert.equal(owner.current(fresh.receipt), true)
  assert.equal(owner.current(refused.receipt), false)
})
