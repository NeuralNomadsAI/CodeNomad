import test from "node:test"
import assert from "node:assert/strict"
import { runNativeOriginInvocation, type NativeInvocationCorrelation } from "./native-missions-invocation"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
/** JS ledger exercises ONLY local lifecycle; it cannot mint a native binding,
 * register an actual writer, publish a journal or qualify the native factory. */
function fixture() {
  const request = new AbortController(), channel = new AbortController()
  const events: string[] = [], records: NativeInvocationCorrelation[] = []
  let live = true
  const origin = { signedDigest: "a".repeat(64), signal: request.signal, channelSignal: channel.signal,
    assertOriginCurrent: (): true => { if (!live) throw Error("origin lost"); return true },
    assertChannelCurrent: (): true => { channel.signal.throwIfAborted(); return true },
  }
  const native = {
    admit: async (bytes: Buffer): Promise<object> => {
      const value = JSON.parse(bytes.toString()) as NativeInvocationCorrelation
      assert.deepEqual(Object.keys(value).sort(), ["invocationID", "signedDigest"])
      records.push(value); events.push(`admit:${value.invocationID}`); return Object.freeze({})
    },
    revoke: (id: string): void => { events.push(`revoke:${id}`) },
    assertCurrent: (_lease: object): void => { events.push("assert") },
    invalidateChannel: (): void => { events.push("invalidate"); channel.abort() },
  }
  return { request, channel, events, records, origin, native, loseOrigin: () => { live = false } }
}

test("originating lifecycle sends only fresh correlation and settles it once", async () => {
  const f = fixture()
  assert.equal(await runNativeOriginInvocation(f.origin, f.native, async correlation => {
    assert.equal(Object.isFrozen(correlation), true)
    assert.match(correlation.invocationID, /^[a-f0-9-]{36}$/)
    assert.equal(correlation.signedDigest, f.origin.signedDigest)
    f.events.push("operation"); return "result"
  }), "result")
  assert.deepEqual(f.events, [`admit:${f.records[0].invocationID}`, "assert", "operation", "assert", `revoke:${f.records[0].invocationID}`])
})
test("cancellation is installed before native admission and fences a late returned lease", async () => {
  const f = fixture(), pending = deferred<object>(), entered = deferred<void>()
  const admit = f.native.admit
  f.native.admit = async bytes => { await admit(bytes); entered.resolve(); return pending.promise }
  let operations = 0
  const operation = runNativeOriginInvocation(f.origin, f.native, async () => { operations++; return 1 })
  await entered.promise
  f.request.abort()
  await assert.rejects(operation, /native-missions-human-invocation-cancelled/)
  assert.equal(f.events.filter(event => event.startsWith("revoke:")).length, 1)
  pending.resolve({}); await Promise.resolve()
  assert.equal(operations, 0)
})
test("a guard that synchronously cancels its own request cannot admit a native lease", async () => {
  const f = fixture()
  f.origin.assertOriginCurrent = () => { f.request.abort(); return true }
  await assert.rejects(runNativeOriginInvocation(f.origin, f.native, async () => 1))
  assert.deepEqual(f.records, [])
})
test("an async or false originating guard cannot become a synchronous human fence", async () => {
  for (const result of [false, Promise.resolve(true)]) {
    const f = fixture()
    f.origin.assertOriginCurrent = (() => result) as () => true
    await assert.rejects(runNativeOriginInvocation(f.origin, f.native, async () => 1), /native-missions-human-invocation-refused/)
    assert.deepEqual(f.records, [])
  }
})
test("origin loss after an operation await refuses its result and revokes the exact invocation", async () => {
  const f = fixture()
  await assert.rejects(runNativeOriginInvocation(f.origin, f.native, async () => { f.loseOrigin(); return "not accepted" }), /origin lost/)
  assert.equal(f.events.filter(event => event.startsWith("revoke:")).length, 1)
})
test("channel loss while awaiting work revokes admission without borrowing another channel", async () => {
  const f = fixture(), entered = deferred<void>(), pending = deferred<number>()
  const result = runNativeOriginInvocation(f.origin, f.native, async () => { entered.resolve(); return pending.promise })
  await entered.promise; f.channel.abort(); pending.resolve(7)
  await assert.rejects(result)
  assert.equal(f.events.filter(event => event.startsWith("revoke:")).length, 1)
})
test("same signed contract retry gets a new invocation and cannot renew the original lease", async () => {
  const f = fixture()
  await runNativeOriginInvocation(f.origin, f.native, async () => 1)
  await runNativeOriginInvocation(f.origin, f.native, async () => 2)
  assert.notEqual(f.records[0].invocationID, f.records[1].invocationID)
  assert.equal(f.records[0].signedDigest, f.records[1].signedDigest)
  for (const item of f.records) assert.equal(f.events.filter(event => event === `revoke:${item.invocationID}`).length, 1)
})
test("native revocation failure closes local authority and cannot report successful settlement", async () => {
  const f = fixture()
  f.native.revoke = () => { throw Error("native detail must not escape") }
  await assert.rejects(runNativeOriginInvocation(f.origin, f.native, async () => 1), /native-missions-human-invocation-refused/)
  assert.equal(f.channel.signal.aborted, true)
  assert.equal(f.events.filter(event => event === "invalidate").length, 1)
})
test("a Promise-returning native assertion is rejected rather than treated as current", async () => {
  const f = fixture()
  f.native.assertCurrent = (() => Promise.resolve()) as () => void
  let calls = 0
  await assert.rejects(runNativeOriginInvocation(f.origin, f.native, async () => { calls++; return 1 }), /native-missions-human-invocation-refused/)
  assert.equal(calls, 0)
})
test("unsettled native admission has a bounded deadline and tombstones the invocation", { timeout: 7_000 }, async () => {
  const f = fixture(), admit = f.native.admit
  f.native.admit = async bytes => { await admit(bytes); return new Promise<object>(() => {}) }
  let calls = 0
  await assert.rejects(runNativeOriginInvocation(f.origin, f.native, async () => { calls++; return 1 }), /native-runtime-timeout/)
  assert.equal(calls, 0)
  assert.equal(f.events.filter(event => event.startsWith("revoke:")).length, 1)
})
test("operation failure revokes its invocation and never replays work", async () => {
  const f = fixture()
  let calls = 0
  await assert.rejects(runNativeOriginInvocation(f.origin, f.native, async () => { calls++; throw Error("operation failed") }), /operation failed/)
  assert.equal(calls, 1)
  assert.equal(f.events.filter(event => event.startsWith("revoke:")).length, 1)
})
