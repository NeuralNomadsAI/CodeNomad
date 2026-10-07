import assert from "node:assert/strict"
import test from "node:test"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { authorityEffectResultSchema } from "../authority-protocol"
import { fixture } from "./test-fixture"

async function evidence(f: Awaited<ReturnType<typeof fixture>>) {
  const names = (await readdir(f.files.directory)).sort()
  return { files: await Promise.all(names.map(async name => [name, (await readFile(path.join(f.files.directory, name))).toString("base64")])),
    native: JSON.stringify(await f.core.store.read()), host: await f.host.read() }
}

const failures = ["caller", "capability", "native-abort", "native-timeout"] as const
function failure(kind: typeof failures[number], cancel: AbortController) {
  if (kind === "caller") cancel.abort(Object.freeze({ source: "original caller", privateDetail: "not a native error" }))
  return kind === "native-abort" ? new DOMException("private native detail", "AbortError")
    : kind === "native-timeout" ? new DOMException("private native deadline", "TimeoutError") : new Error("private capability detail")
}
function expected(kind: typeof failures[number], cancel: AbortController) {
  return (error: unknown) => kind === "caller" ? error === cancel.signal.reason
    : !cancel.signal.aborted && error instanceof Error
      && (error as Error & { code?: string }).code === "native-observation-unavailable"
      && error.message === "Host mission authority rejected: native-observation-unavailable"
}

test("discovery cancellation preserves caller reason and bytes; native failures remain opaque at both reads", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  const original = f.nativeBridge.readDiscoveryBoundary.bind(f.nativeBridge)
  for (const read of [1, 2]) for (const kind of failures) {
    const cancel = new AbortController(), before = await evidence(f)
    let reads = 0
    f.nativeBridge.readDiscoveryBoundary = async signal => {
      if (++reads === read) throw failure(kind, cancel)
      return original(signal)
    }
    const body = await f.body("adopt", {})
    await assert.rejects(f.host.sign(f.request, body, before.host!.revision, cancel.signal), expected(kind, cancel))
    assert.equal(reads, read)
    assert.deepEqual(await evidence(f), before)
  }
})

test("handshake cancellation preserves caller reason and bytes; native failures remain opaque", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare()
  for (const kind of failures) {
    const cancel = new AbortController(), before = await evidence(f)
    f.nativeBridge.handshake = async () => { throw failure(kind, cancel) }
    const body = await f.body("adopt", {})
    await assert.rejects(f.host.sign(f.request, body, before.host!.revision, cancel.signal), expected(kind, cancel))
    assert.deepEqual(await evidence(f), before)
  }
})

test("receipt cancellation preserves caller reason and pending denial without replaying recorded Play", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.prepare(); await f.execute(await f.body("adopt", {}))
  const beforeSign = (await f.host.read())!, body = await f.body("lifecycle", { action: "start" })
  const signed = await f.host.sign(f.request, body, beforeSign.revision)
  let effects = 0
  const result = await f.core.execute(signed, { expectedSigner: (await f.host.read())!.signer!,
    apply: async intent => { effects++; return f.apply(intent) } }, new AbortController().signal)
  const state = await f.core.state(f.target.missionID)
  const revision = authorityEffectResultSchema.parse(result.receipt.completion!.result).revision
  assert(revision !== undefined)
  f.setObservation({ operation: result, revision,
    terminal: state.terminal, pendingRequestIDs: state.pendingRequestIDs })
  const before = await evidence(f)
  assert(before.host!.pendingDigest)
  assert.equal(before.host!.mirror!.sendsEnabled, false)
  assert.equal(state.grant!.sendsEnabled, true)
  for (const read of [1, 2]) for (const kind of failures) {
    const cancel = new AbortController()
    let reads = 0
    f.betweenNativeReads(() => { if (++reads === read) throw failure(kind, cancel) })
    await assert.rejects(f.host.accept(f.request, before.host!.pendingDigest!, before.host!.revision, cancel.signal), expected(kind, cancel))
    assert.equal(reads, read)
    assert.deepEqual(await evidence(f), before)
    assert.equal(effects, 1)
  }
  f.betweenNativeReads(() => {})
  const accepted = await f.host.accept(f.request, before.host!.pendingDigest!, before.host!.revision)
  assert.equal(accepted.pendingDigest, null)
  assert.equal(accepted.mirror!.sendsEnabled, true)
  assert.equal(JSON.stringify(await f.core.store.read()), before.native)
  assert.equal(effects, 1, "explicit receipt reconciliation does not replay the already recorded Play")
})
