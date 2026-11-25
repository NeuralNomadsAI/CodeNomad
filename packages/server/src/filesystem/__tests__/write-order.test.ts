import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { FileSystemBrowser } from "../browser"

test("concurrent saves through distinct browsers cannot interleave file contents", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-write-order-")))
  const target = path.join(root, "file.txt")
  fs.writeFileSync(target, "initial", "utf8")
  const originalRename = fs.promises.rename.bind(fs.promises)
  let release!: () => void
  let started!: () => void
  let stalledFirst = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  t.mock.method(fs.promises, "rename", async (...args: Parameters<typeof fs.promises.rename>) => {
    if (!stalledFirst && path.resolve(String(args[1])) === path.resolve(target)) {
      stalledFirst = true
      started()
      await gate
    }
    return originalRename(...args)
  })
  let first: Promise<string> | undefined
  let second: Promise<void> | undefined
  try {
    first = new FileSystemBrowser({ rootDir: root }).writeFile("file.txt", "first-large-save")
    await Promise.race([entered, first.then(() => { throw new Error("first save finished before stalling") })])
    let secondFinished = false
    second = new FileSystemBrowser({ rootDir: root }).writeFile("file.txt", "last-save")
      .then(() => { secondFinished = true })
    const read = new FileSystemBrowser({ rootDir: root }).readFile("file.txt")
    // Independent paths must remain writable while the first file is stalled.
    await new FileSystemBrowser({ rootDir: root }).writeFile("other.txt", "independent")
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(secondFinished, false)
    release()
    await Promise.all([first, second])
    t.mock.restoreAll()
    assert.equal(await read, "last-save")
    assert.equal(await fs.promises.readFile(target, "utf8"), "last-save")
    assert.deepEqual(fs.readdirSync(root).sort(), ["file.txt", "other.txt"])
  } finally {
    release()
    await Promise.allSettled([first, second].filter(Boolean))
    t.mock.restoreAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a failed save does not poison subsequent saves", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-write-error-"))
  const browser = new FileSystemBrowser({ rootDir: root })
  try {
    await assert.rejects(browser.writeFile("dir/file.txt", "first"), { code: "ENOENT" })
    fs.mkdirSync(path.join(root, "dir"))
    await browser.writeFile("dir/file.txt", "recovered")
    assert.equal(await browser.readFile("dir/file.txt"), "recovered")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
