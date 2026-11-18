import assert from "node:assert/strict"
import { it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { storage } from "../lib/storage.ts"

const saved: Record<string, unknown> = {}
const answers: Array<() => void> = []
serverApi.fetchConfigOwner = async () => ({}) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchStateOwner = (async (_owner: string, patch: Record<string, unknown>) => {
  await new Promise<void>((resolve) => answers.push(resolve))
  return Object.assign(saved, patch)
}) as any

const { lastCloneParent, rememberCloneParent } = await import("./preferences.tsx")

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

it("saves clone parents in order and native shutdown waits for queued ones", async () => {
  rememberCloneParent("C:\\first")
  rememberCloneParent("D:\\latest")
  assert.equal(lastCloneParent(), "D:\\latest", "the window's latest clone parent is suggested at once")
  let flushed = false
  const flush = storage.flushWrites().then(() => { flushed = true })

  await settle()
  assert.equal(answers.length, 1, "the second save waits for the first")
  answers.shift()!()
  await settle()
  assert.equal(saved.lastCloneParent, "C:\\first")
  assert.equal(flushed, false, "the queued save still holds the drain")
  answers.shift()!()
  await flush
  assert.equal(saved.lastCloneParent, "D:\\latest")
  assert.equal(lastCloneParent(), "D:\\latest")
})
