import assert from "node:assert/strict"
import test from "node:test"
import type { SignedAuthorityIntent } from "../authority-protocol"
import { HumanIntentLeases } from "./human-intents"
import { fixture } from "./test-fixture"

// Structural map tests only: these contracts do not authorize native effects.
const signed = (requestID: string) => ({ body: { requestID }, signature: "unit-correlation" }) as SignedAuthorityIntent
const signal = new AbortController().signal

test("captured settled or missing leases cannot join a later identical signed retry", async () => {
  const leases = new HumanIntentLeases(), intent = signed("same")
  const missing = leases.capture(intent)
  let old!: () => true
  await leases.run(intent, signal, () => true, async () => { old = leases.capture(intent); assert.equal(old(), true) })
  assert.throws(old); assert.throws(missing)
  await leases.run(intent, signal, () => true, async () => {
    assert.equal(leases.capture(intent)(), true)
    assert.throws(old); assert.throws(missing)
    await assert.rejects(leases.run(intent, signal, () => true, async () => {}), /request-conflict/)
  })
})

test("bounded concurrent scopes isolate origin auth, cancellation, exact signature and settlement", async () => {
  const leases = new HumanIntentLeases(2), cancel = new AbortController()
  let authenticated = true
  const a = signed("a"), b = signed("b")
  await leases.run(a, signal, () => { if (!authenticated) throw new Error("expired a"); return true }, async () => {
    const oldA = leases.capture(a)
    await leases.run(b, cancel.signal, () => true, async () => {
      const oldB = leases.capture(b)
      assert.throws(leases.capture({ ...b, signature: "changed" }))
      await assert.rejects(leases.run(signed("third"), signal, () => true, async () => {}), /capacity/)
      authenticated = false
      assert.throws(oldA); assert.equal(oldB(), true)
      authenticated = true; cancel.abort()
      assert.throws(oldB); assert.equal(oldA(), true)
    })
    assert.equal(oldA(), true)
  })
  await leases.run(signed("after-settlement"), signal, () => true, async () => {})
})

test("request correlation never awaits malformed guard results or attacker thenables", async () => {
  const leases = new HumanIntentLeases()
  let calls = 0, assimilated = 0
  for (const guard of [() => undefined, () => false, () => Promise.resolve(true), () => Promise.reject(new Error("no")),
    () => ({ then() { assimilated++ } })]) {
    await assert.rejects(leases.run(signed("bad"), signal, guard as never, async () => { calls++ }), /policy-unqualified/)
  }
  assert.equal(calls, 0); assert.equal(assimilated, 0)
})

test("actual canonical plugin captures original per-RPC leases and a newer human intent cannot revive settled guards", async t => {
  const f = await fixture(); t.after(f.cleanup)
  const capture = f.host.captureHumanIntent!, pinned: Array<() => true> = []
  f.setHumanCapture(input => {
    const lease = capture(input)
    for (const old of pinned) assert.throws(old)
    pinned.push(lease)
    assert.equal(lease(), true)
    return lease
  })
  await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
  assert.equal(pinned.length, 3)
  for (const old of pinned) assert.throws(old)
  assert.equal(f.counts.synthetics, 1)
})
