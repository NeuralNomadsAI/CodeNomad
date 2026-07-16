import assert from "node:assert/strict"
import test from "node:test"
import { SerializedLifecycle } from "./serialized-lifecycle"

test("serializes operations and exposes shutdown before queued work resumes", async () => {
  const lifecycle = new SerializedLifecycle()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let active = 0, maximum = 0
  const first = lifecycle.enqueue(async () => {
    active += 1; maximum = Math.max(maximum, active)
    await gate
    active -= 1
    if (lifecycle.stopped) throw new Error("stopped")
  })
  const second = lifecycle.enqueue(async () => {
    active += 1; maximum = Math.max(maximum, active); active -= 1
  })
  const shutdown = lifecycle.stop(async () => {})
  release()
  await assert.rejects(first, /stopped/)
  await second
  await shutdown
  assert.equal(maximum, 1)
})
