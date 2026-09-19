import assert from "node:assert/strict"
import { it } from "node:test"
import { BackgroundReadQueue } from "./background-read-queue"

it("shares the background budget across scans and cancels queued work before dispatch", async () => {
  const queue = new BackgroundReadQueue(2)
  const releases: Array<() => void> = []
  const started: number[] = []
  const controllers = Array.from({ length: 6 }, () => new AbortController())
  let active = 0
  let peak = 0
  const reads = controllers.map((controller, index) => queue.run(controller.signal, async () => {
    started.push(index)
    peak = Math.max(peak, ++active)
    await new Promise<void>(resolve => releases.push(resolve))
    active -= 1
    return index
  }))
  const cancelled = assert.rejects(reads[2], /Abort/)
  controllers[2].abort()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(started, [0, 1])
  for (let index = 0; index < 5; index += 1) {
    releases[index]()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  await cancelled
  assert.deepEqual(await Promise.all(reads.filter((_, index) => index !== 2)), [0, 1, 3, 4, 5])
  assert.equal(peak, 2)
  await assert.rejects(queue.run(new AbortController().signal, async () => { throw new Error("failed") }), /failed/)
  assert.equal(await queue.run(new AbortController().signal, async () => 7), 7)
})
