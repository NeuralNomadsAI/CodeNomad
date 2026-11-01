import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createOfferRegistry, capabilityHash } from "./fake-integration/core.mjs"
import { startOfferRenewal, findConfirmation } from "./bundles-management.mjs"

test("fixture renewal uses real advertise, preserves a 15-second offer and drains its owned worker", { timeout: 2_000 }, async () => {
  let now = 0, calls = 0, enter, release
  const capabilities = { methods: ["hello"], operations: [], undo: "none", background: true }
  const input = { host: "127.0.0.1", port: 12345, token: "a".repeat(64), script_handle: "fixture_handle", label: "Scene", protocol: 1, offer_key: "fixture" }
  const registry = createOfferRegistry({ now: () => now, hello: async () => ({ protocol: 1, host_version: "0.1.0", app_version: "5.2.0",
    script_handle: input.script_handle, revision: 0, capability_hash: capabilityHash(capabilities), capabilities }) })
  const reached = new Promise(resolve => { enter = resolve }), gate = new Promise(resolve => { release = resolve })
  const stop = await startOfferRenewal(async value => {
    calls++
    if (calls === 4) { enter(); await gate }
    now += 6_000
    return registry.advertise(value)
  }, input, 1)
  const original = registry.hosts().offers[0].offerID
  try {
    await reached
    assert(now >= 18_000); assert.equal(registry.hosts().offers[0].offerID, original)
    let stopped = false
    const stopping = stop().then(() => { stopped = true })
    await delay(5); assert.equal(stopped, false, "Cleanup joins the in-flight advertise")
    release(); await stopping
    const before = calls; await delay(10); assert.equal(calls, before, "Cleanup starts no later advertisement")
  } finally { release(); await stop() }
})

test("fixture renewal reports a refused/expired offer rather than silently recreating it", { timeout: 2_000 }, async () => {
  let calls = 0, reached
  const ready = new Promise(resolve => { reached = resolve })
  const stop = await startOfferRenewal(async () => { calls++; if (calls > 1) reached(); return { outcome: calls === 1 ? "accepted" : "refused" } }, {}, 1)
  await ready
  await assert.rejects(stop(), /same live host offer renews/)
})

test("confirmation wait reports early failed/cancelled/expired terminals instead of confirmation", () => {
  const view = { requestID: "one", planID: "plan" }
  assert.equal(findConfirmation([], "one"), undefined)
  assert.equal(findConfirmation([{ view }], "one"), view)
  for (const outcome of ["failed", "cancelled", "expired", "confirmed"]) {
    assert.throws(() => findConfirmation([{ view }, { change: { requestID: "one", outcome } }], "one"), new RegExp(`Preparation terminated: ${outcome}`))
  }
  assert.equal(findConfirmation([{ change: { requestID: "other", outcome: "failed" } }, { view }], "one"), view)
})
