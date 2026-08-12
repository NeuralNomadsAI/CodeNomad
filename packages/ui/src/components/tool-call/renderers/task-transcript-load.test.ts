import assert from "node:assert/strict"
import test from "node:test"
import { createRoot, createSignal } from "solid-js"
import { useTaskTranscriptLoad } from "./task-transcript-load.ts"

test("a remounted task retries a cancelled transcript load after its loading marker clears", async () => {
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const requests: Array<{ signal: AbortSignal; resolve: () => void }> = []
  const load = (_sessionId: string, signal: AbortSignal) => new Promise<void>((resolve) => {
    requests.push({ signal, resolve })
    setLoading(true)
  })
  const mount = () => createRoot((dispose) => {
    useTaskTranscriptLoad({ sessionId: () => "child", enabled: () => true, loaded, loading, load })
    return dispose
  })

  const disposeFirst = mount()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].signal.aborted, false, "setting the owned loading marker must not cancel its request")

  disposeFirst()
  assert.equal(requests[0].signal.aborted, true)

  const disposeRemount = mount()
  assert.equal(requests.length, 1, "the remount joins the still-marked request")

  setLoading(false)
  assert.equal(requests.length, 2, "the remount retries when cancellation clears the marker")

  setLoaded(true)
  setLoading(false)
  requests[0].resolve()
  requests[1].resolve()
  await Promise.resolve()
  disposeRemount()
})
