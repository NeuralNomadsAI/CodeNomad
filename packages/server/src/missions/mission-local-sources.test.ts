import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { readMissionLocalSource } from "./mission-local-sources"

function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode", "mission-source-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  return { root, git }
}

test("explicit files baseline, stable bytes, creation/deletion, restart and read/reservation races", async t => {
  const { root } = fixture(t), condition = { kind: "files-changed" as const, paths: ["included", "nested/new"] }
  writeFileSync(path.join(root, "included"), "old")
  const baseline = await readMissionLocalSource(condition, root)
  assert.equal(baseline.changed, false)
  assert.equal((await readMissionLocalSource({ ...condition, paths: [...condition.paths].reverse() }, root, baseline.checkpoint)).changed, false)
  await assert.rejects(readMissionLocalSource(condition, root, { ...baseline.checkpoint, value: { files: [], digest: "a".repeat(64) } }))
  writeFileSync(path.join(root, "excluded"), "not observed")
  assert.equal((await readMissionLocalSource(condition, root, baseline.checkpoint)).changed, false)
  writeFileSync(path.join(root, "included"), "new")
  await assert.rejects(baseline.revalidate(), /unavailable or changed/)
  assert.throws(baseline.current, /unavailable or changed/)
  const changed = await readMissionLocalSource(condition, root, JSON.parse(JSON.stringify(baseline.checkpoint)))
  assert.equal(changed.changed, true)
  mkdirSync(path.join(root, "nested")); writeFileSync(path.join(root, "nested/new"), "created during pending")
  await assert.rejects(changed.revalidate())
  assert.throws(changed.current)
  assert.equal((await readMissionLocalSource(condition, root, changed.checkpoint)).changed, true)
  rmSync(path.join(root, "included"))
  assert.equal((await readMissionLocalSource(condition, root, changed.checkpoint)).changed, true)
})

test("files reject file/aggregate bounds, directories, aliases, junctions and cancellation", async t => {
  const { root } = fixture(t), read = (paths: string[]) => readMissionLocalSource({ kind: "files-changed", paths }, root)
  mkdirSync(path.join(root, "directory"))
  await assert.rejects(read(["directory"]))
  await assert.rejects(read(["../escape"]))
  await assert.rejects(read(["nul.txt"]))
  writeFileSync(path.join(root, "huge"), Buffer.alloc(1024 * 1024 + 1))
  await assert.rejects(read(["huge"]))
  const paths = Array.from({ length: 17 }, (_, i) => `file${i}`)
  paths.forEach(file => writeFileSync(path.join(root, file), Buffer.alloc(1024 * 1024)))
  await assert.rejects(read(paths))
  await assert.rejects(read(Array.from({ length: 129 }, (_, i) => `file${i}`)))
  symlinkSync(path.join(root, "directory"), path.join(root, "link"), process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(read(["link/missing"]))
  await assert.rejects(readMissionLocalSource({ kind: "files-changed", paths: ["missing"] }, root, undefined, AbortSignal.abort()))
})

test("a file changed during its byte read is refused, rather than published as a stable fingerprint", async t => {
  const { root } = fixture(t), file = path.join(root, "changing"), original = fs.open
  writeFileSync(file, "before")
  let changed = false
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const fd = await original(...args), read = fd.read.bind(fd)
    t.mock.method(fd, "read", async (...args: Parameters<typeof fd.read>) => {
      const count = await read(...args)
      if (!changed) { changed = true; writeFileSync(file, "different length after read") }
      return count
    })
    return fd
  })
  await assert.rejects(readMissionLocalSource({ kind: "files-changed", paths: ["changing"] }, root))
  assert.equal(changed, true)
})

test("local branch uses ancestry, ignores dirty/other branch work, pins linked worktrees, refuses rewrite/deletion", async t => {
  const { root, git } = fixture(t)
  git("init", "-b", "selected"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@invalid")
  writeFileSync(path.join(root, "file"), "base"); git("add", "file"); git("commit", "-m", "base")
  const condition = { kind: "branch-commits" as const, directory: root, ref: "refs/heads/selected" }
  const baseline = await readMissionLocalSource(condition, root)
  writeFileSync(path.join(root, "file"), "dirty")
  assert.equal((await readMissionLocalSource(condition, root, baseline.checkpoint)).changed, false)
  git("switch", "-c", "other"); git("add", "file"); git("commit", "-m", "other")
  assert.equal((await readMissionLocalSource(condition, root, baseline.checkpoint)).changed, false)
  git("switch", "selected"); writeFileSync(path.join(root, "file"), "selected new"); git("add", "file"); git("commit", "-m", "next")
  const next = await readMissionLocalSource(condition, root, JSON.parse(JSON.stringify(baseline.checkpoint)))
  assert.equal(next.changed, true); await assert.rejects(baseline.revalidate())
  const linked = path.join(root, "linked")
  git("worktree", "add", "-b", "linked", linked)
  const linkedCondition = { ...condition, directory: linked, ref: "refs/heads/linked" }
  assert.equal((await readMissionLocalSource(linkedCondition, linked)).changed, false)
  git("switch", "other"); git("branch", "-f", "selected", "HEAD")
  await assert.rejects(readMissionLocalSource(condition, root, next.checkpoint))
  git("branch", "-D", "selected")
  await assert.rejects(readMissionLocalSource(condition, root, baseline.checkpoint))
})

test("hung filesystem metadata yields the event loop and rejects at the shared ten-second deadline", async t => {
  const { root } = fixture(t)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let calls = 0
  t.mock.method(fs, "lstat", () => { calls++; return new Promise(() => {}) })
  const pending = readMissionLocalSource({ kind: "files-changed", paths: ["missing"] }, root)
  const rejected = assert.rejects(pending, /deadline exceeded/)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(calls, 1, "the unresolved OS operation has started while the event loop remains responsive")
  t.mock.timers.tick(10_000)
  await rejected
})

test("cancellation bounds a hung open and closes its eventual handle without further reads", async t => {
  const { root } = fixture(t), file = path.join(root, "file"), controller = new AbortController()
  writeFileSync(file, "bytes")
  let release!: (fd: Awaited<ReturnType<typeof fs.open>>) => void, started!: () => void, closed!: () => void
  const opening = new Promise<void>(resolve => { started = resolve })
  const closing = new Promise<void>(resolve => { closed = resolve })
  const fd = await fs.open(file, "r"), close = fd.close.bind(fd)
  t.mock.method(fd, "close", async () => { await close(); closed() })
  const stat = t.mock.method(fd, "stat", () => { throw new Error("late handle must only be closed") })
  t.mock.method(fs, "open", () => { started(); return new Promise(resolve => { release = resolve }) })
  const pending = readMissionLocalSource({ kind: "files-changed", paths: ["file"] }, root, undefined, controller.signal)
  const rejected = assert.rejects(pending, /cancelled/)
  await opening
  controller.abort(new Error("cancelled"))
  await rejected
  release(fd)
  await closing
  assert.equal(stat.mock.callCount(), 0)
})

test("revalidation is bounded and its synchronous CAS guard performs no filesystem I/O", async t => {
  const { root } = fixture(t), controller = new AbortController()
  const read = await readMissionLocalSource({ kind: "files-changed", paths: ["missing"] }, root, undefined, controller.signal)
  await read.revalidate()
  const lstat = t.mock.method(fs, "lstat", () => new Promise(() => {}))
  assert.equal(read.current(), true)
  assert.equal(lstat.mock.callCount(), 0)
  const pending = read.revalidate(), rejected = assert.rejects(pending, /cancelled/)
  assert.throws(read.current, /unavailable or changed/, "a refresh in progress cannot authorize publication")
  controller.abort(new Error("cancelled"))
  await rejected
  assert.throws(read.current, /cancelled/)
})

test("revalidation rejects replacement placement even when the observed bytes match", async t => {
  const { root } = fixture(t), moved = `${root}-moved`
  t.after(() => rmSync(moved, { recursive: true, force: true }))
  writeFileSync(path.join(root, "file"), "same")
  const read = await readMissionLocalSource({ kind: "files-changed", paths: ["file"] }, root)
  renameSync(root, moved)
  mkdirSync(root)
  writeFileSync(path.join(root, "file"), "same")
  await assert.rejects(read.revalidate(), /unavailable or changed/)
  assert.throws(read.current, /unavailable or changed/)
})

test("revalidation retains the original deadline and fails closed after a hung read", async t => {
  const { root } = fixture(t), now = performance.now.bind(performance)
  let elapsed = 0
  t.mock.method(performance, "now", () => now() + elapsed)
  const read = await readMissionLocalSource({ kind: "files-changed", paths: ["missing"] }, root)
  elapsed = 9_000
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.method(fs, "lstat", () => new Promise(() => {}))
  const pending = read.revalidate(), rejected = assert.rejects(pending, /deadline exceeded/)
  t.mock.timers.tick(1_000)
  await rejected
  assert.throws(read.current, /unavailable or changed/)
})

test("a cancelled kernel byte read can finish later and still closes its handle", async t => {
  const { root } = fixture(t), file = path.join(root, "file"), controller = new AbortController(), open = fs.open
  writeFileSync(file, "bytes")
  let release!: () => void, started!: () => void, closed!: () => void
  const reading = new Promise<void>(resolve => { started = resolve })
  const closing = new Promise<void>(resolve => { closed = resolve })
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const fd = await open(...args), close = fd.close.bind(fd)
    t.mock.method(fd, "read", () => { started(); return new Promise(resolve => { release = () => resolve({ bytesRead: 0 }) }) })
    t.mock.method(fd, "close", async () => { await close(); closed() })
    return fd
  })
  const pending = readMissionLocalSource({ kind: "files-changed", paths: ["file"] }, root, undefined, controller.signal)
  const rejected = assert.rejects(pending, /cancelled/)
  await reading
  controller.abort(new Error("cancelled"))
  await rejected
  release()
  await closing
})
