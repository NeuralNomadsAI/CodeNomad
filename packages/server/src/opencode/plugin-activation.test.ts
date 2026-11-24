import assert from "node:assert/strict"
import { test } from "node:test"
import { awaitNativePlugin } from "./plugin-activation"

test("activation polls only its exact catalogue entry, under cancellation and caller authority", async () => {
  const location = { directory: "/owned/cold" }
  let reads = 0, active = false, owned = true, failed = false, outputLocation = location
  const controller = new AbortController()
  const client = { plugin: { list: async (input: any, options: any) => {
    assert.deepEqual(input, { location })
    assert.equal(options.signal, controller.signal)
    reads++
    return { location: outputLocation, data: active || failed
      ? [{ id: "wanted", state: { status: failed ? "failed" : "active" } }]
      : [{ id: "other", state: { status: "active" } }] }
  } } } as any
  const run = () => awaitNativePlugin(client, "wanted", location, controller.signal, () => {
    if (!owned) throw new Error("Owner changed")
  })
  const waiting = run()
  active = true
  await waiting
  assert.equal(reads, 2)
  failed = true
  await assert.rejects(run(), /activation failed/)
  failed = false
  outputLocation = { directory: "/foreign" }
  await assert.rejects(run(), /Location changed/)
  outputLocation = location
  owned = false
  const before = reads
  await assert.rejects(run(), /Owner changed/)
  assert.equal(reads, before)
  owned = true
  controller.abort(new Error("Cancelled"))
  await assert.rejects(run(), /Cancelled/)
  assert.equal(reads, before)
})
