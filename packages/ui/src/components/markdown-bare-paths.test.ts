import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client"
import { BARE_PATH_LISTING_DEADLINE_MS, BARE_PATH_TTL_MS, clearBarePathCaches, fileNamesInDirectory } from "./markdown-bare-paths"

type Entry = { name: string; type: string }

const patchListing = (impl: (relativePath: string, directory: string | undefined, signal?: AbortSignal) => Promise<Entry[]>) => {
  const original = serverApi.listWorkspaceFiles
  const calls: Array<{ relativePath: string; directory: string | undefined }> = []
  serverApi.listWorkspaceFiles = (async (_id: string, relativePath = ".", directory?: string, signal?: AbortSignal) => {
    calls.push({ relativePath, directory })
    return await impl(relativePath, directory, signal)
  }) as typeof original
  return { calls, restore: () => { serverApi.listWorkspaceFiles = original } }
}

/** A listing that never settles on its own; it rejects when the signal aborts, like fetch. */
const stalledListing = (signal?: AbortSignal) => new Promise<Entry[]>((_resolve, reject) => {
  signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")), { once: true })
})

describe("directory existence cache", () => {
  it("answers concurrent callers from one shared flight", async () => {
    clearBarePathCaches()
    let release!: (entries: Entry[]) => void
    const stub = patchListing(() => new Promise<Entry[]>(resolve => { release = resolve }))
    try {
      const first = fileNamesInDirectory("inst", "/repo", "src")
      const second = fileNamesInDirectory("inst", "/repo", "src")
      // The shared background queue starts the read a tick later.
      await new Promise(resolve => setImmediate(resolve))
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
      await new Promise(resolve => setImmediate(resolve))
      release([{ name: "app.ts", type: "file" }])
      const [a, b] = await Promise.all([first, second])
      assert.deepEqual([...a], ["app.ts"])
      assert.deepEqual([...b], ["app.ts"])
      assert.equal(stub.calls.length, 1)
    } finally { stub.restore() }
  })

  it("bounds concurrent listings through the shared background budget", async () => {
    clearBarePathCaches()
    let active = 0, peak = 0
    const stub = patchListing(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return [{ name: "a.ts", type: "file" }]
    })
    try {
      // A summary naming a file in each of several directories must not open
      // every listing at once: passive transcript decoration leaves room for
      // foreground reads through the shared background queue.
      const parents = Array.from({ length: 8 }, (_, index) => `d${index}`)
      await Promise.all(parents.map(parent => fileNamesInDirectory("inst", "/repo", parent)))
      assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the background budget`)
    } finally { stub.restore() }
  })

  it("cancels a listing once its last consumer leaves", async () => {
    clearBarePathCaches()
    const consumer = new AbortController()
    const stub = patchListing((_path, _directory, signal) => stalledListing(signal))
    try {
      const first = fileNamesInDirectory("inst", "/repo", "src", { signal: consumer.signal })
      await new Promise(resolve => setImmediate(resolve))
      consumer.abort()
      assert.equal((await first).size, 0, "the leaving consumer converts nothing")
      // The entry is revoked, not published: a later demand re-requests.
      await new Promise(resolve => setTimeout(resolve, 10))
    } finally { stub.restore() }
    const healthy = patchListing(async () => [{ name: "app.ts", type: "file" }])
    try {
      const second = await fileNamesInDirectory("inst", "/repo", "src")
      assert.deepEqual([...second], ["app.ts"])
      assert.equal(healthy.calls.length, 1)
    } finally { healthy.restore() }
  })

  it("keeps the shared read alive through a streaming rerender", async () => {
    clearBarePathCaches()
    let release!: (entries: Entry[]) => void
    const consumerA = new AbortController(), consumerB = new AbortController()
    const stub = patchListing((_path, _directory, signal) => new Promise<Entry[]>((resolve, reject) => {
      release = resolve
      signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")), { once: true })
    }))
    try {
      const first = fileNamesInDirectory("inst", "/repo", "src", { signal: consumerA.signal })
      await new Promise(resolve => setImmediate(resolve))
      // The successor pass registers before the superseded one's abort lands.
      const second = fileNamesInDirectory("inst", "/repo", "src", { signal: consumerB.signal })
      consumerA.abort()
      await new Promise(resolve => setTimeout(resolve, 10))
      release([{ name: "app.ts", type: "file" }])
      assert.deepEqual([...(await second)], ["app.ts"], "the successor still receives the shared read")
      await first.catch(() => undefined)
      assert.equal(stub.calls.length, 1)
    } finally { stub.restore() }
  })

  it("times a dispatched listing out at its deadline", async t => {
    clearBarePathCaches()
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
    const stub = patchListing((_path, _directory, signal) => stalledListing(signal))
    try {
      const first = fileNamesInDirectory("inst", "/repo", "src")
      t.mock.timers.tick(BARE_PATH_LISTING_DEADLINE_MS + 1)
      assert.equal((await first).size, 0, "a stalled listing fails closed at its deadline")
    } finally { stub.restore(); t.mock.timers.reset() }
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
