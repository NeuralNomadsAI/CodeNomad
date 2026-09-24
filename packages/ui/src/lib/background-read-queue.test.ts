import assert from "node:assert/strict"
import { it } from "node:test"
import { BackgroundReadQueue } from "./background-read-queue"

it("admits visible panels ahead of bulk scans without exceeding the shared budget", async () => {
  const queue = new BackgroundReadQueue(1), signal = new AbortController().signal
  let release!: () => void
  const blocker = queue.run(signal, () => new Promise<void>(resolve => { release = resolve }))
  const started: string[] = []
  const bulk = queue.run(signal, async () => { started.push("bulk") })
  const cancelled = new AbortController()
  const obsolete = queue.run(cancelled.signal, async () => { started.push("obsolete") }, "visible")
  const rejection = assert.rejects(obsolete, /Abort/)
  cancelled.abort()
  const visible = queue.run(signal, async () => { started.push("visible") }, "visible")
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(started, [])
  release()
  await Promise.all([blocker, bulk, visible, rejection])
  assert.deepEqual(started, ["visible", "bulk"])
})

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
