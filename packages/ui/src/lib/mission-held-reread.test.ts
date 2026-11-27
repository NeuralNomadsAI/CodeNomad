import assert from "node:assert/strict"
import test from "node:test"
import { createRoot, createSignal } from "solid-js"
import { MISSION_HELD_REREAD_MS, rereadMissionHoldWhileActive } from "./mission-held-reread"

test("rereadMissionHoldWhileActive rereads immediately and on interval while held and active, stopping on clear, inactivity or disposal", t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const [held, setHeld] = createSignal<string | undefined>()
  const [active, setActive] = createSignal(true)
  let reads = 0
  let dispose!: () => void

  createRoot(cleanup => {
    dispose = cleanup
    rereadMissionHoldWhileActive(held, active, async () => { reads++ })
  })

  // Inactive or unheld: nothing runs.
  assert.equal(reads, 0)
  t.mock.timers.tick(MISSION_HELD_REREAD_MS * 2)
  assert.equal(reads, 0)

  // Becoming held while active rereads immediately and every MISSION_HELD_REREAD_MS.
  setHeld("req_1")
  assert.equal(reads, 1)
  t.mock.timers.tick(MISSION_HELD_REREAD_MS - 1)
  assert.equal(reads, 1)
  t.mock.timers.tick(1)
  assert.equal(reads, 2)
  t.mock.timers.tick(MISSION_HELD_REREAD_MS)
  assert.equal(reads, 3)

  // Another truthy value keeps the cadence without firing a duplicate reread.
  setHeld("req_1:partial")
  assert.equal(reads, 3)

  // Becoming inactive stops the interval; returning active rereads immediately and resumes.
  setActive(false)
  t.mock.timers.tick(MISSION_HELD_REREAD_MS * 3)
  assert.equal(reads, 3)

  setActive(true)
  assert.equal(reads, 4)
  t.mock.timers.tick(MISSION_HELD_REREAD_MS)
  assert.equal(reads, 5)

  // Clearing the hold stops the interval.
  setHeld(undefined)
  t.mock.timers.tick(MISSION_HELD_REREAD_MS * 3)
  assert.equal(reads, 5)

  // Disposing the owner stops an active interval.
  setHeld("req_2")
  assert.equal(reads, 6)
  dispose()
  t.mock.timers.tick(MISSION_HELD_REREAD_MS * 3)
  assert.equal(reads, 6)
})

test("rereadMissionHoldWhileActive does not track signals read or written by reread", t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const [held, setHeld] = createSignal<string | undefined>("req_1")
  const [busy, setBusy] = createSignal(false)
  let reads = 0
  let dispose!: () => void

  createRoot(cleanup => {
    dispose = cleanup
    rereadMissionHoldWhileActive(held, () => true, async () => {
      if (busy()) return
      setBusy(true)
      reads++
      setBusy(false)
    })
  })

  assert.equal(reads, 1)
  setBusy(true)
  setBusy(false)
  assert.equal(reads, 1, "toggling busy inside or outside reread must not re-trigger the effect")
  t.mock.timers.tick(MISSION_HELD_REREAD_MS)
  assert.equal(reads, 2)
  setHeld(undefined)
  dispose()
})
