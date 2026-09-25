import assert from "node:assert/strict"
import { afterEach, it } from "node:test"
import { serverApi } from "./api-client"
import { ServerStorage } from "./storage"

const originalPatchConfigOwner = serverApi.patchConfigOwner

afterEach(() => {
  serverApi.patchConfigOwner = originalPatchConfigOwner
})

it("flushes an in-flight server write", async () => {
  let resolveWrite!: (value: Record<string, unknown>) => void
  serverApi.patchConfigOwner = <T extends Record<string, unknown>>() => new Promise<T>((resolve) => {
    resolveWrite = (value) => resolve(value as T)
  })
  const storage = new ServerStorage()
  const write = storage.patchConfigOwner("server", { opencodeBinary: "opencode2" })
  let flushed = false
  const flush = storage.flushWrites().then(() => {
    flushed = true
  })

  await Promise.resolve()
  assert.equal(flushed, false)
  resolveWrite({ opencodeBinary: "opencode2" })
  await flush
  assert.deepEqual(await write, { opencodeBinary: "opencode2" })
})
