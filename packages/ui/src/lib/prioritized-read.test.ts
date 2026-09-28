import assert from "node:assert/strict"
import { it } from "node:test"
import { createSignal } from "solid-js"
import { backgroundReads } from "./background-read-queue"
import { prioritizedRead } from "./prioritized-read"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

it("promotes a queued read once, without waiting for or consuming secondary slots", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const signal = new AbortController().signal
  const slots = [backgroundReads.run(signal, () => gate), backgroundReads.run(signal, () => gate)]
  const [selected, select] = createSignal(false)
  let calls = 0
  const request = prioritizedRead(selected, signal, async () => ++calls)
  try {
    await tick()
    assert.equal(calls, 0)
    select(true)
    assert.equal(await request, 1)
    select(false)
    select(true)
    assert.equal(calls, 1)
  } finally { release(); await Promise.allSettled([...slots, request]) }
  assert.equal(calls, 1, "the removed queue entry must never run again")
})

it("does not restart a dispatched read when selection changes", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const [selected, select] = createSignal(false)
  let calls = 0
  const request = prioritizedRead(selected, new AbortController().signal, async () => { calls++; await gate })
  try {
    await tick()
    assert.equal(calls, 1)
    select(true)
    await tick()
    assert.equal(calls, 1)
  } finally { release(); await request }
})

it("cancellation wins over promotion before dispatch", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const controller = new AbortController()
  const slots = [0, 1].map(() => backgroundReads.run(new AbortController().signal, () => gate))
  const [selected, select] = createSignal(false)
  let calls = 0
  const request = prioritizedRead(selected, controller.signal, async () => { calls++ })
  const rejected = assert.rejects(request, { name: "AbortError" })
  try {
    select(true)
    controller.abort()
    await rejected
    assert.equal(calls, 0)
  } finally { release(); await Promise.allSettled([...slots, request]) }
})
