import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client"
import { BARE_PATH_TTL_MS, clearBarePathCaches, fileNamesInDirectory } from "./markdown-bare-paths"

type Entry = { name: string; type: string }

const patchListing = (impl: (relativePath: string, directory: string | undefined) => Promise<Entry[]>) => {
  const original = serverApi.listWorkspaceFiles
  const calls: Array<{ relativePath: string; directory: string | undefined }> = []
  serverApi.listWorkspaceFiles = (async (_id: string, relativePath = ".", directory?: string) => {
    calls.push({ relativePath, directory })
    return await impl(relativePath, directory)
  }) as typeof original
  return { calls, restore: () => { serverApi.listWorkspaceFiles = original } }
}

describe("directory existence cache", () => {
  it("answers concurrent callers from one shared flight", async () => {
    clearBarePathCaches()
    let release!: (entries: Entry[]) => void
    const stub = patchListing(() => new Promise<Entry[]>(resolve => { release = resolve }))
    try {
      const first = fileNamesInDirectory("inst", "/repo", "src")
      const second = fileNamesInDirectory("inst", "/repo", "src")
      release([{ name: "app.ts", type: "file" }])
      const [a, b] = await Promise.all([first, second])
      assert.deepEqual([...a], ["app.ts"])
      assert.deepEqual([...b], ["app.ts"])
      assert.equal(stub.calls.length, 1)
    } finally { stub.restore() }
  })

  it("serves a fresh entry without a new request", async () => {
    clearBarePathCaches()
    const stub = patchListing(async () => [{ name: "app.ts", type: "file" }])
    try {
      await fileNamesInDirectory("inst", "/repo", "src")
      await fileNamesInDirectory("inst", "/repo", "src")
      assert.equal(stub.calls.length, 1)
    } finally { stub.restore() }
  })

  it("revalidates an entry once the TTL expires", async t => {
    t.mock.timers.enable({ apis: ["Date"] })
    clearBarePathCaches()
    const stub = patchListing(async () => [{ name: "a.ts", type: "file" }])
    try {
      await fileNamesInDirectory("inst", "/repo", "src")
      t.mock.timers.tick(BARE_PATH_TTL_MS + 1)
      await fileNamesInDirectory("inst", "/repo", "src")
      assert.equal(stub.calls.length, 2)
    } finally { stub.restore(); t.mock.timers.reset() }
  })

  it("excludes directories from the file-name set", async () => {
    clearBarePathCaches()
    const stub = patchListing(async () => [{ name: "app.ts", type: "file" }, { name: "sub", type: "directory" }])
    try {
      const names = await fileNamesInDirectory("inst", "/repo", "src")
      assert.deepEqual([...names], ["app.ts"])
    } finally { stub.restore() }
  })

  it("fails closed on a rejected listing and recovers after the TTL", async t => {
    t.mock.timers.enable({ apis: ["Date"] })
    clearBarePathCaches()
    let failing = true
    const stub = patchListing(async () => {
      if (failing) throw new Error("listing unavailable")
      return [{ name: "x.ts", type: "file" }]
    })
    try {
      const empty = await fileNamesInDirectory("inst", "/repo", "src")
      assert.equal(empty.size, 0)
      // The failed listing's empty set is cached: prose false positives stay cheap.
      await fileNamesInDirectory("inst", "/repo", "src")
      assert.equal(stub.calls.length, 1)
      failing = false
      t.mock.timers.tick(BARE_PATH_TTL_MS + 1)
      const recovered = await fileNamesInDirectory("inst", "/repo", "src")
      assert.deepEqual([...recovered], ["x.ts"])
    } finally { stub.restore(); t.mock.timers.reset() }
  })

  it("keeps the last good set when a refresh fails", async t => {
    t.mock.timers.enable({ apis: ["Date"] })
    clearBarePathCaches()
    let failing = false
    const stub = patchListing(async () => {
      if (failing) throw new Error("listing unavailable")
      return [{ name: "a.ts", type: "file" }]
    })
    try {
      await fileNamesInDirectory("inst", "/repo", "src")
      failing = true
      t.mock.timers.tick(BARE_PATH_TTL_MS + 1)
      const kept = await fileNamesInDirectory("inst", "/repo", "src")
      assert.deepEqual([...kept], ["a.ts"])
      assert.equal(stub.calls.length, 2)
    } finally { stub.restore(); t.mock.timers.reset() }
  })

  it("a slow listing is shared by sequential callers without re-request", async () => {
    clearBarePathCaches()
    let release!: (entries: Entry[]) => void
    const stub = patchListing(() => new Promise<Entry[]>(resolve => { release = resolve }))
    try {
      const first = fileNamesInDirectory("inst", "/repo", "src")
      // A later caller arrives while the shared flight is still pending —
      // the render pass that started it may already be gone, and the
      // listing must complete regardless, serving both.
      const second = fileNamesInDirectory("inst", "/repo", "src")
      release([{ name: "app.ts", type: "file" }])
      const [a, b] = await Promise.all([first, second])
      assert.deepEqual([...a], ["app.ts"])
      assert.deepEqual([...b], ["app.ts"])
      assert.equal(stub.calls.length, 1)
    } finally { stub.restore() }
  })

  it("keys the cache by instance, directory and parent path", async () => {
    clearBarePathCaches()
    const stub = patchListing(async () => [])
    try {
      await fileNamesInDirectory("inst", "/repo", "src")
      await fileNamesInDirectory("inst", "/repo", "docs")
      await fileNamesInDirectory("other", "/repo", "src")
      assert.equal(stub.calls.length, 3)
    } finally { stub.restore() }
  })
})
