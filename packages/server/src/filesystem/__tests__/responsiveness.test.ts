import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { test } from "node:test"
import Fastify from "fastify"
import { FileSystemBrowser } from "../browser"
import { searchWorkspaceFiles } from "../search"
import { registerFilesystemRoutes } from "../../server/routes/filesystem"

test("slow directory I/O leaves HTTP and child exit processing responsive", { timeout: 10_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-slow-io-"))
  fs.writeFileSync(path.join(root, "needle.txt"), "fixture")
  const originalStat = fs.promises.stat.bind(fs.promises)
  let release!: () => void
  let entered!: () => void
  const stalled = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  t.mock.method(fs.promises, "stat", async (...args: Parameters<typeof fs.promises.stat>) => {
    entered()
    await gate
    return originalStat(...args)
  })
  t.mock.method(fs, "statSync", () => { throw new Error("Synchronous filesystem access on HTTP thread") })
  const app = Fastify()
  registerFilesystemRoutes(app, { fileSystemBrowser: new FileSystemBrowser({ rootDir: root }) })
  app.get("/health", async () => ({ ok: true }))
  await app.ready()
  let finished = false
  const listing = app.inject("/api/filesystem").then((response) => { finished = true; return response })
  const search = searchWorkspaceFiles(root, "needle", { refresh: true })
  try {
    await stalled
    assert.equal((await app.inject("/health")).statusCode, 200)
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
    assert.deepEqual(await once(child, "close"), [0, null])
    assert.equal(finished, false, "listing must still be waiting for disk I/O")
    release()
    const response = await listing
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().entries[0].name, "needle.txt")
    assert.equal((await search)[0].name, "needle.txt")
  } finally {
    release()
    await Promise.allSettled([listing, search])
    await app.close()
    t.mock.restoreAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("filesystem routes preserve asynchronous errors and attachment size limits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-fs-errors-"))
  const app = Fastify()
  registerFilesystemRoutes(app, { fileSystemBrowser: new FileSystemBrowser({ rootDir: root }) })
  try {
    assert.equal((await app.inject("/api/filesystem?path=missing")).statusCode, 400)
    assert.equal((await app.inject("/api/filesystem/files/content?path=missing")).statusCode, 400)
    const payload = { name: "new-folder" }
    assert.equal((await app.inject({ method: "POST", url: "/api/filesystem/folders", payload })).statusCode, 201)
    assert.equal((await app.inject({ method: "POST", url: "/api/filesystem/folders", payload })).statusCode, 409)
    const fd = fs.openSync(path.join(root, "large.sqlite"), "w")
    try { fs.ftruncateSync(fd, 6 * 1024 * 1024) } finally { fs.closeSync(fd) }
    const response = await app.inject("/api/filesystem/files/content?path=large.sqlite")
    assert.equal(response.statusCode, 400)
    assert.match(response.body, /too large/)
  } finally {
    await app.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
