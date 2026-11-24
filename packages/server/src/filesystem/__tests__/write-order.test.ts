import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { FileSystemBrowser } from "../browser"

test("concurrent saves through distinct browsers cannot interleave file contents", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-write-order-"))
  const target = path.join(root, "file.txt")
  const original = fs.promises.writeFile.bind(fs.promises)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  t.mock.method(fs.promises, "writeFile", async (...args: Parameters<typeof fs.promises.writeFile>) => {
    if (args[1] === "first-large-save") {
      await original(target, "first-")
      started()
      await gate
      // Model the multiple underlying writes used by fs.writeFile for large data.
      await fs.promises.appendFile(target, "large-save")
    } else await original(...args)
  })
  const first = new FileSystemBrowser({ rootDir: root }).writeFile("file.txt", "first-large-save")
  await entered
  let secondFinished = false
  const second = new FileSystemBrowser({ rootDir: root }).writeFile("file.txt", "last-save")
    .then(() => { secondFinished = true })
  const read = new FileSystemBrowser({ rootDir: root }).readFile("file.txt")
  try {
    // Independent paths must remain writable while the first file is stalled.
    await new FileSystemBrowser({ rootDir: root }).writeFile("other.txt", "independent")
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(secondFinished, false)
  } finally {
    release()
    await Promise.all([first, second])
    t.mock.restoreAll()
  }
  try {
    assert.equal(await read, "last-save")
    assert.equal(await fs.promises.readFile(target, "utf8"), "last-save")
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
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
