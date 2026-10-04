import assert from "node:assert/strict"
import test from "node:test"
import { readFile, readdir } from "node:fs/promises"
import { fixture } from "./test-fixture"

async function evidence(f: Awaited<ReturnType<typeof fixture>>) {
  const names = await readdir(f.files.directory).catch(error => { if (error.code === "ENOENT") return null; throw error })
  return { directoryExists: names !== null, files: await Promise.all((names ?? []).sort().map(async name =>
    [name, (await readFile(`${f.files.directory}/${name}`)).toString("base64")])),
    native: structuredClone([...f.storage.data]), writes: f.storage.writes, counts: { ...f.counts } }
}

test("pre-aborted create leaves exact protected bytes, absence, native data and provider counts unchanged", async t => {
  const f = await fixture(); t.after(f.cleanup)
  const before = await evidence(f), cancel = new AbortController(); cancel.abort()
  await assert.rejects(f.create(cancel.signal), { name: "AbortError" })
  assert.deepEqual(await evidence(f), before)
  await assert.rejects(readFile(f.recordFile), { code: "ENOENT" })
})

test("pre-aborted Pause preserves enabled grant, exact host revision/bytes and all native counts", async t => {
  const f = await fixture(); t.after(f.cleanup)
  await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
  const before = await evidence(f), cancel = new AbortController(); cancel.abort()
  await assert.rejects(f.action("lifecycle", { action: "pause" }, "pre-aborted-pause", cancel.signal), { name: "AbortError" })
  assert.deepEqual(await evidence(f), before)
  assert.equal((await f.authority.read())!.mirror!.sendsEnabled, true)
})

test("cancellation during real private handshake prevents protected staging and native reservation", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {})
  const before = await evidence(f), cancel = new AbortController()
  f.afterHandshake(() => cancel.abort())
  await assert.rejects(f.action("lifecycle", { action: "start" }, "cancel-handshake", cancel.signal), { name: "AbortError" })
  assert.deepEqual(await evidence(f), before)
})

test("cancellation during create ownership preparation publishes no key/marker or native reservation", async t => {
  const f = await fixture(); t.after(f.cleanup)
  const before = await evidence(f), cancel = new AbortController()
  f.setSessionGet(async () => { cancel.abort() })
  await assert.rejects(f.create(cancel.signal), { name: "AbortError" })
  assert.deepEqual(await evidence(f), before)
})

test("cancellation during actual protected create CAS preparation publishes no key or installation marker", async t => {
  const f = await fixture(); t.after(f.cleanup)
  const cancel = new AbortController(), check = f.files.check.bind(f.files)
  const native = structuredClone([...f.storage.data]), writes = f.storage.writes, counts = { ...f.counts }
  f.files.check = async () => { await check(); cancel.abort() }
  await assert.rejects(f.create(cancel.signal), { name: "AbortError" })
  await assert.rejects(readFile(f.recordFile), { code: "ENOENT" })
  await assert.rejects(readFile(f.markerFile), { code: "ENOENT" })
  assert.deepEqual([...f.storage.data], native); assert.equal(f.storage.writes, writes)
  assert.deepEqual(f.counts, counts)
  assert.deepEqual(await readdir(f.files.directory), [], "CAS claim was released; no inferred rollback or reservation")
})

test("cancellation during environment preparation retains honest reservations but sends nothing", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {})
  const cancel = new AbortController()
  f.setEnvironmentPreparation(async () => { cancel.abort() })
  await assert.rejects(f.action("lifecycle", { action: "start" }, "cancel-environment", cancel.signal))
  assert.equal(f.counts.environments, 0); assert.equal(f.counts.synthetics, 0)
  const doc = await f.nativeStore.read()
  assert.equal(doc.grants[0].sendsEnabled, false)
  assert(doc.receipts.some(item => item.requestID === "cancel-environment" && !item.completion))
  assert((await f.authority.read())!.pendingDigest)
})

test("abort during native receipt acceptance cannot publish the protected enabled mirror", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {})
  const cancel = new AbortController()
  let before: string | undefined
  f.setReceiptRead(async () => { before ??= await readFile(f.recordFile, "utf8"); cancel.abort() })
  await assert.rejects(f.action("lifecycle", { action: "start" }, "cancel-accept", cancel.signal), { name: "AbortError" })
  assert.equal(await readFile(f.recordFile, "utf8"), before)
  assert((await f.authority.read())!.pendingDigest)
  assert.equal((await f.authority.read())!.mirror!.sendsEnabled, false)
  assert.equal((await f.nativeStore.read()).grants[0].sendsEnabled, true, "completed native effect is not rolled back/inferred away")
})
