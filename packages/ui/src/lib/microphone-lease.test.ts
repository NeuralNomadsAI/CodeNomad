import assert from "node:assert/strict"
import test from "node:test"
import { createMicrophoneLeases, MicrophoneUnavailable } from "./microphone-lease"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(callback => { resolve = callback })
  return { promise, resolve }
}

test("a pending admission retains the reason; cancelled late claims hold through asynchronous release", async () => {
  const admission = deferred<() => Promise<void>>()
  const closure = deferred<void>()
  let attempts = 0
  const claim = createMicrophoneLeases(() => {
    attempts++
    return attempts === 1 ? admission.promise : Promise.resolve(() => {})
  })
  const current = new AbortController()
  const waiting = claim("dictation", current.signal)
  const expectBusy = () => assert.rejects(claim("test", new AbortController().signal),
    (error: unknown) => error instanceof MicrophoneUnavailable && error.reason === "dictation")
  await expectBusy()
  current.abort()
  await expectBusy()
  admission.resolve(() => closure.promise)
  await expectBusy()
  assert.equal(attempts, 1)
  closure.resolve()
  await assert.rejects(waiting, { name: "AbortError" })
  const next = await claim("conversation", new AbortController().signal)
  assert.equal(attempts, 2)
  await next.release()
})
