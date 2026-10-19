import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rename, unlink, symlink, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { WorkspaceFileWatches } from "./file-watches"

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate(), "filesystem observation reached the display invalidation")
}
const quiet = () => new Promise(resolve => setTimeout(resolve, 220))

test("listed directories invalidate on create, edit, rename and delete without recursive watching", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-file-watch-"))
  const changes: string[] = [], errors: unknown[] = []
  const watches = new WorkspaceFileWatches(id => changes.push(id), error => errors.push(error))
  t.after(async () => { watches.close(); await rm(root, { recursive: true, force: true }) })
  const child = path.join(root, "src")
  await mkdir(child)
  await watches.observe("workspace", root, root, () => true)
  await watches.observe("workspace", root, root, () => true)
  for (const action of [() => writeFile(path.join(root, "new.txt"), "one"),
    () => writeFile(path.join(root, "new.txt"), "two"),
    () => rename(path.join(root, "new.txt"), path.join(root, "renamed.txt")),
    () => unlink(path.join(root, "renamed.txt"))]) {
    const before = changes.length
    await action()
    await until(() => changes.length > before)
  }
  await watches.observe("workspace", root, child, () => true)
  const before = changes.length
  await writeFile(path.join(child, "nested.txt"), "nested")
  await until(() => changes.length > before)
  assert.ok(changes.every(id => id === "workspace"))
  watches.forget("workspace")
  const stopped = changes.length
  await writeFile(path.join(root, "later.txt"), "later")
  await quiet()
  assert.equal(changes.length, stopped)
  assert.deepEqual(errors, [])
})

test("late observation admission and queued events cannot outlive a workspace or shutdown", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-file-watch-lifetime-"))
  let current = true
  const changes: string[] = []
  const watches = new WorkspaceFileWatches(id => changes.push(id), () => {})
  t.after(async () => { watches.close(); await rm(root, { recursive: true, force: true }) })
  const pending = watches.observe("late", root, root, () => current)
  current = false
  await pending
  await writeFile(path.join(root, "no-watch.txt"), "no watch")
  await quiet()
  assert.deepEqual(changes, [])
  current = true
  await watches.observe("closed", root, root, () => current)
  await writeFile(path.join(root, "queued.txt"), "queued")
  watches.forget("closed")
  await quiet()
  assert.deepEqual(changes, [])
  watches.close()
  await watches.observe("closed", root, root, () => true)
  await writeFile(path.join(root, "after-close.txt"), "closed")
  await quiet()
  assert.deepEqual(changes, [])
})

test("observation stays inside the owned physical tree, and a replaced directory gets a new watch", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "codenomad-file-watch-boundary-"))
  const root = path.join(base, "root"), foreign = path.join(base, "foreign"), child = path.join(root, "child")
  await mkdir(root); await mkdir(foreign); await mkdir(child)
  const changes: string[] = []
  const watches = new WorkspaceFileWatches(id => changes.push(id), () => {})
  t.after(async () => { watches.close(); await rm(base, { recursive: true, force: true }) })
  const alias = path.join(root, "alias")
  await symlink(foreign, alias, process.platform === "win32" ? "junction" : "dir")
  await watches.observe("foreign", root, foreign, () => true)
  await watches.observe("alias", root, alias, () => true)
  await writeFile(path.join(foreign, "outside.txt"), "outside")
  await quiet()
  assert.deepEqual(changes, [])
  await watches.observe("child", root, child, () => true)
  await rename(child, path.join(root, "old-child"))
  await mkdir(child)
  await watches.observe("child", root, child, () => true)
  await quiet()
  const before = changes.length
  await writeFile(path.join(child, "new.txt"), "new inode")
  await until(() => changes.length > before)
})

test("native watcher handles are bounded and repeated reads retain the most recently used entries", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-file-watch-budget-"))
  const changes: string[] = [], errors: unknown[] = []
  const watches = new WorkspaceFileWatches(id => changes.push(id), error => errors.push(error), 2)
  t.after(async () => { watches.close(); await rm(root, { recursive: true, force: true }) })
  for (const name of ["a", "b", "c"]) await mkdir(path.join(root, name))
  for (const name of ["a", "b", "a", "c"]) await watches.observe(name, root, path.join(root, name), () => true)
  await writeFile(path.join(root, "b", "evicted.txt"), "not watched")
  await quiet()
  assert.equal(changes.length, 0)
  await writeFile(path.join(root, "a", "visible.txt"), "watched")
  await until(() => changes.includes("a"))
  assert.equal(errors.length, 1)
})
