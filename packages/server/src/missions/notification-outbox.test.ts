import assert from "node:assert/strict"
import test from "node:test"

import { MissionNotificationOutbox } from "./notification-outbox"

test("keeps one notification recovery pass in flight and fences its next retry on dispose", async () => {
  let calls = 0
  let entered!: () => void
  let release!: () => void
  let activeDuringPass!: () => boolean
  const started = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const outbox = new MissionNotificationOutbox(`outbox-dispose-${Math.random()}`, async isActive => {
    calls += 1
    activeDuringPass = isActive
    entered()
    await blocked
    return { attempted: 1, failed: 0, cursor: "after-report-1" }
  }, 5)

  outbox.start()
  await started
  outbox.start()
  assert.equal(calls, 1, "start/reload activity must not enqueue concurrent passes")
  outbox.dispose()
  assert.equal(activeDuringPass(), false)
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls, 1, "dispose prevents the scheduled follow-up pass")
})

test("backs off after failed passes without overlapping or accumulating timer callbacks", async () => {
  let calls = 0
  let firstEntered!: () => void
  const started = new Promise<void>(resolve => { firstEntered = resolve })
  const outbox = new MissionNotificationOutbox(`outbox-backoff-${Math.random()}`, async () => {
    calls += 1
    if (calls === 1) {
      firstEntered()
      return { attempted: 1, failed: 1 }
    }
    outbox.dispose()
    return { attempted: 0, failed: 0 }
  }, 10, 20)

  outbox.start()
  await started
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(calls, 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls, 2)
})
