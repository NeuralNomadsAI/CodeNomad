import assert from "node:assert/strict"
import test from "node:test"
import { MissionJournal } from "../journal"
import { fixture, existingRootExecution } from "./test-fixture"

async function prepared(t: { after(fn: () => Promise<void>): void }) {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {}); return f
}

for (const phase of ["preparation", "environment-ack"] as const) {
  test(`original real AuthManager cookie loss during Play ${phase} fences actual native effects`, async t => {
    const f = await prepared(t), cookie = f.request.headers.cookie
    const expire = async () => f.expireHumanSession()
    if (phase === "preparation") f.setEnvironmentPreparation(expire)
    else f.setEnvironmentWrite(expire)
    await assert.rejects(f.action("lifecycle", { action: "start" }, `cookie-${phase}`))
    assert.equal(f.request.headers.cookie, cookie, "origin cookie did not change; its real session was invalidated")
    assert.equal(f.counts.environments, phase === "preparation" ? 0 : 1)
    assert.equal(f.counts.synthetics, 0)
    const doc = await f.nativeStore.read()
    assert.equal(doc.grants[0].sendsEnabled, false)
    assert(doc.receipts.some(item => item.requestID === `cookie-${phase}` && !item.completion))
    assert((await f.authority.read())!.pendingDigest)
  })
}

test("cookie invalidation during real native reservation preparation prevents native publication", async t => {
  const f = await prepared(t), native = structuredClone([...f.storage.data]), writes = f.storage.writes
  const host = (await f.authority.read())!
  const revision = (await new MissionJournal(f.storage, "test-project", f.project).snapshot()).missions[0].revision
  const scan = f.storage.scan.bind(f.storage)
  let invalidated = false
  f.storage.scan = async options => {
    const result = await scan(options)
    invalidated = true; f.expireHumanSession()
    return result
  }
  await assert.rejects(f.actions.execute(f.request, { method: "lifecycle", payload: { action: "start" }, requestID: "native-preparation",
    expectedRevision: revision, expectedHostRevision: host.revision }, f.signal))
  assert(invalidated)
  assert.deepEqual([...f.storage.data], native); assert.equal(f.storage.writes, writes)
  assert.equal(f.counts.environments, 0); assert.equal(f.counts.synthetics, 0)
  assert.equal((await f.nativeStore.read()).grants[0].sendsEnabled, false)
  assert((await f.authority.read())!.pendingDigest, "only the legitimate protected signature reservation survives")
})

test("human invalidation during late native journal ACK preparation does not apply Play or enable sends", async t => {
  const f = await prepared(t)
  const scan = f.storage.scan.bind(f.storage)
  f.storage.scan = async options => {
    const result = await scan(options)
    if (f.counts.synthetics) f.expireHumanSession()
    return result
  }
  await assert.rejects(f.action("lifecycle", { action: "start" }, "late-journal"))
  assert.equal(f.counts.environments, 1); assert.equal(f.counts.synthetics, 1)
  assert.equal((await f.nativeStore.read()).grants[0].sendsEnabled, false)
  assert.equal([...f.storage.data.values()].some(item => (item as any)?.type === "mission.control-applied"), false)
})

test("human invalidation during native completion observation cannot enable sends after a legitimate journal ACK", async t => {
  const f = await prepared(t)
  let invalidated = false
  f.setSessionGet(async () => {
    if ([...f.storage.data.values()].some(item => (item as any)?.type === "mission.control-applied")) {
      invalidated = true; f.expireHumanSession()
    }
  })
  await assert.rejects(f.action("lifecycle", { action: "start" }, "late-completion"))
  assert(invalidated)
  const doc = await f.nativeStore.read()
  assert.equal(doc.grants[0].sendsEnabled, false)
  assert(doc.receipts.some(item => item.requestID === "late-completion" && !item.completion))
  const map = await new MissionJournal(f.storage, "test-project", f.project).snapshot()
  assert.equal(map.missions[0].runState, "running", "already-published native ACK remains truthful")
})

test("valid autonomous grant dispatch ignores expired unrelated human cookie even during environment preparation", async t => {
  const f = await prepared(t); await f.action("lifecycle", { action: "start" })
  const missionID = (await f.authority.read())!.binding.missionID
  f.setEnvironmentPreparation(async () => f.expireHumanSession())
  await f.runTool("delegate", { missionID, taskKey: "autonomous", title: "One", brief: "Granted work", role: "worker",
    targetSessionID: "ses_test_actor", blockedBy: [], delivery: "queue", ...existingRootExecution() })
  assert.equal(f.counts.prompts, 1); assert.equal(f.counts.environments, 2)
  assert.equal((await f.nativeStore.read()).grants[0].sendsEnabled, true)
})

test("original human lease fences Play after the canonical per-target transport queue wait", { timeout: 15_000 }, async t => {
  const f = await prepared(t)
  let entered!: () => void, release!: () => void
  const preparing = new Promise<void>(resolve => { entered = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const execute = f.host.transport.execute.bind(f.host.transport)
  let queued!: Promise<unknown>
  // The real plugin supplies the exact signed Play reservation and captured
  // original guard. Queue a second identical native-target admission while the
  // first is preparing, BEFORE either admits a native write. This exercises the
  // actual canonical queue without another MissionControl project-lock owner.
  f.host.transport.execute = (request, options) => {
    const first = execute(request, options)
    queued = execute(request, options).catch(error => error)
    return first
  }
  f.setEnvironmentPreparation(async () => { entered(); await hold })
  const play = f.action("lifecycle", { action: "start" }, "cookie-queue").catch(error => error)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([preparing, play.then(result => { throw result instanceof Error ? result : new Error("Play settled before preparation") }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Play preparation gate not reached")), 5_000) })])
    f.expireHumanSession(); release()
    assert(await play instanceof Error)
    assert(await queued instanceof Error)
    assert.equal(f.counts.environments, 0); assert.equal(f.counts.synthetics, 0)
    assert.equal((await f.nativeStore.read()).grants[0].sendsEnabled, false)
    assert((await f.authority.read())!.pendingDigest)
  } finally { clearTimeout(timer); release(); await Promise.allSettled([play, queued]) }
})

test("canonical transport refuses a signed human effect with a missing lease rather than using native grant alone", async t => {
  const f = await prepared(t), execute = f.host.transport.execute.bind(f.host.transport)
  f.host.transport.execute = (request, options) => execute(request, { signal: options.signal, assertCurrent: options.assertCurrent })
  await assert.rejects(f.action("lifecycle", { action: "start" }, "missing-transport-lease"))
  assert.equal(f.counts.environments, 0); assert.equal(f.counts.synthetics, 0)
  assert.equal((await f.nativeStore.read()).grants[0].sendsEnabled, false)
})

for (const kind of ["missing", "false", "async", "rejected-promise", "thenable", "missing-capture"] as const) {
  test(`canonical native plugin rejects ${kind} originating lease before native writes`, async t => {
    const f = await prepared(t)
    const capture = f.host.captureHumanIntent!
    const before = structuredClone([...f.storage.data]), writes = f.storage.writes
    let assimilated = 0
    const bad = () => kind === "missing" ? undefined : kind === "false" ? false : kind === "async" ? Promise.resolve(true)
      : kind === "rejected-promise" ? Promise.reject(new Error("bad async")) : { then() { assimilated++ } }
    // The real RPC/core still validates the signed typed contract; only the
    // restrictive host fence result is faulted at its actual synchronous use.
    f.setHumanCapture(signed => { capture(signed); return kind === "missing-capture" ? undefined as never : (() => bad()) as never })
    await assert.rejects(f.action("lifecycle", { action: "start" }, "bad-guard"))
    // Signing may stage an honest host reservation, but cannot reserve native.
    assert.deepEqual([...f.storage.data], before); assert.equal(f.storage.writes, writes)
    assert.equal(assimilated, 0)
    assert.equal(f.counts.environments, 0); assert.equal(f.counts.synthetics, 0)
  })
}
