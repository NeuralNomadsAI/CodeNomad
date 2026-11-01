import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BundlesLifecycle, BundlesStalePlanError, BUNDLES_PLAN_MS, BUNDLES_CONFIRMATION_MS, type BundlesClock, type BundlesConfirmation, type BundlesPrepared,
  type BundlesTarget } from "./bundles-lifecycle"
import { PanelExtensionStore } from "./store"
import { NativeMutationAdmission } from "../opencode/native-mutation-authority"

class Clock implements BundlesClock {
  at = 0; timers = new Map<object, { at: number; fn(): void }>()
  now = () => this.at
  setTimeout(fn: () => void, delay: number) { const id = {}; this.timers.set(id, { at: this.at + delay, fn }); return id }
  clearTimeout(id: unknown) { this.timers.delete(id as object) }
  advance(ms: number) {
    this.at += ms
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.at) { this.timers.delete(id); timer.fn() }
  }
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
const initial: BundlesTarget = { instance: "instance", session: "ses_one", location: "/owned", connection: "connection1",
  integration: "blender", scope: "global", range: "^1.0.0", documentDigest: "sha256:document1" }
function fixture(time = new Clock(), lifecycle = new BundlesLifecycle(time), extension = "test.one", digest = "a".repeat(64)) {
  const mountAbort = new AbortController(), consent = new AbortController(), events: unknown[] = []
  let view: BundlesConfirmation | null = null, target = { ...initial }, dispatched = 0, revalidated = 0
  const authority = { signal: consent.signal, assertCurrent() { consent.signal.throwIfAborted() },
    async revalidate() { revalidated++; consent.signal.throwIfAborted() } }
  const owner = lifecycle.mount({ extension, digest, signal: mountAbort.signal, authority,
    show(value) { view = value }, changed(event) { events.push(event) } })
  const prepared: BundlesPrepared = { target: { ...initial }, display: { action: "install", integration: "Blender", scope: "global", version: "1.0.0", conversation: "One" },
    async readTarget() { return { ...target } }, async dispatch(authority, submitted) {
      const admission = new NativeMutationAdmission(authority)
      await admission.revalidate(); admission.admit(); submitted(); dispatched++
      // Authority remains usable after admission for subsequent native metadata steps.
      await admission.revalidate(); admission.assertCurrent()
    } }
  const request = () => lifecycle.request(owner, async () => prepared)
  const open = async () => { const result = request(); result.afterAck(); await flush(); assert.ok(view); lifecycle.displayed(owner, view.planID); return result }
  return { time, lifecycle, owner, prepared, request, open, events, mountAbort, consent, get view() { return view },
    get dispatched() { return dispatched }, get revalidated() { return revalidated }, setTarget(value: BundlesTarget) { target = value } }
}

test("ACK precedes preparation/view; 128-bit identities, 30s human wait, guarded single-use dispatch and exactly one terminal", async () => {
  const f = fixture(), result = f.request()
  assert.equal(result.ack.outcome, "confirming"); assert.equal(f.view, null); assert.equal(f.revalidated, 0)
  if (result.ack.outcome !== "confirming") return
  assert.match(result.ack.requestID, /^[a-f0-9]{32}$/)
  result.afterAck(); result.afterAck(); await flush()
  const plan = f.view!.planID
  assert.match(plan, /^[a-f0-9]{32}$/); assert.notEqual(plan, result.ack.requestID)
  f.lifecycle.displayed(f.owner, plan)
  f.time.advance(499); f.lifecycle.confirm(f.owner, plan); f.lifecycle.confirm(f.owner, plan)
  assert.equal(f.dispatched, 0)
  f.time.advance(101); f.time.advance(30_000)
  f.lifecycle.confirm(f.owner, plan); f.lifecycle.confirm(f.owner, plan); await flush()
  assert.equal(f.dispatched, 1)
  assert.deepEqual(f.events, [{ kind: "request", requestID: result.ack.requestID, outcome: "confirmed" }])
  f.lifecycle.confirm(f.owner, plan); assert.equal(f.dispatched, 1)
})

test("all exact target bindings fence before callback; plan and mount cannot be presented by another owner", async () => {
  for (const key of Object.keys(initial) as Array<keyof BundlesTarget>) {
    const f = fixture(); await f.open(); f.time.advance(600)
    f.setTarget({ ...initial, [key]: key === "scope" ? "project" : "changed" })
    f.lifecycle.confirm(f.owner, f.view!.planID); await flush()
    assert.equal(f.dispatched, 0, key); assert.equal((f.events[0] as any).outcome, "failed", key)
  }
  const f = fixture(), other = fixture(f.time, f.lifecycle, "test.other")
  await f.open(); f.time.advance(600)
  f.lifecycle.confirm(other.owner, f.view!.planID); f.lifecycle.confirm({ ...f.owner, digest: "b".repeat(64) }, f.view!.planID)
  f.lifecycle.confirm(f.owner, "a".repeat(32)); await flush(); assert.equal(f.dispatched, 0)
  f.lifecycle.confirm(f.owner, f.view!.planID); await flush(); assert.equal(f.dispatched, 1)
})

test("mount disposal, consent revocation, navigation round trip, restart and late preparation cannot dispatch", async () => {
  for (const action of ["dispose", "consent", "navigation", "restart"] as const) {
    const f = fixture(); await f.open(); const plan = f.view!.planID; f.time.advance(600)
    if (action === "consent") f.consent.abort()
    else if (action === "restart") f.lifecycle.dispose()
    else f.mountAbort.abort() // Navigation permanently revokes this mount even if the user comes back.
    assert.equal(f.view, null)
    f.lifecycle.confirm(f.owner, plan); await flush(); assert.equal(f.dispatched, 0)
    assert.equal(f.events.length, 1)
    if (action === "restart") { const fresh = fixture(); fresh.lifecycle.confirm(f.owner, plan); assert.equal(fresh.dispatched, 0) }
  }
  const f = fixture(); let resolve!: (value: BundlesPrepared) => void
  const result = f.lifecycle.request(f.owner, () => new Promise(done => { resolve = done }))
  result.afterAck(); await flush(); f.mountAbort.abort(); resolve(f.prepared); await flush()
  assert.equal(f.view, null); assert.equal(f.dispatched, 0); assert.equal(f.events.length, 1)
})

test("revocation during final revalidation and native prerequisite await prevents submission", async () => {
  for (const boundary of ["target", "native"] as const) {
    const f = fixture(); let release!: () => void
    const held = () => new Promise<void>(resolve => { release = resolve })
    if (boundary === "target") f.prepared.readTarget = async () => { await held(); return { ...initial } }
    else f.prepared.dispatch = async (authority, submitted) => { await held(); authority.assertCurrent(); submitted(); assert.fail("revoked callback") }
    await f.open(); f.time.advance(600); f.lifecycle.confirm(f.owner, f.view!.planID); await flush()
    f.consent.abort(); release(); await flush()
    assert.equal(f.dispatched, 0); assert.equal((f.events[0] as any).outcome, "failed"); assert.equal(f.events.length, 1)
  }
})

test("post-submission revocation emits no second terminal, never replays, and stops further writes", async () => {
  const f = fixture(); let release!: () => void, calls = 0
  f.prepared.dispatch = async (authority, submitted) => {
    authority.assertCurrent(); submitted(); calls++
    await new Promise<void>(resolve => { release = resolve }); authority.assertCurrent(); calls++
  }
  await f.open(); f.time.advance(600); const plan = f.view!.planID
  f.lifecycle.confirm(f.owner, plan); await flush(); f.consent.abort(); release(); await flush()
  assert.equal(calls, 1); assert.equal((f.events[0] as any).outcome, "confirmed"); assert.equal(f.events.length, 1)
  f.lifecycle.confirm(f.owner, plan); assert.equal(calls, 1)
})

test("target change or plan expiry during native prerequisite waits prevents later submission", async () => {
  for (const change of ["document", "expiry"] as const) {
    const f = fixture(); let release!: () => void, writes = 0
    f.prepared.dispatch = async (authority, submitted) => {
      await new Promise<void>(resolve => { release = resolve })
      await authority.revalidate(); authority.assertCurrent(); submitted(); writes++
    }
    await f.open(); f.time.advance(600); f.lifecycle.confirm(f.owner, f.view!.planID); await flush()
    if (change === "expiry") f.time.advance(BUNDLES_PLAN_MS)
    else f.setTarget({ ...initial, documentDigest: "changed-during-native-await" })
    release(); await flush()
    assert.equal(writes, 0)
    assert.equal(f.events.length, 1)
    assert.equal((f.events[0] as any).outcome, change === "expiry" ? "expired" : "failed")
  }
})

test("shared arbiter refuses other extensions; 2min confirmation and 5min preparation/plan expire", async () => {
  const f = fixture(), other = fixture(f.time, f.lifecycle, "test.other")
  await f.open(); assert.equal(other.request().ack.outcome, "busy")
  f.time.advance(BUNDLES_CONFIRMATION_MS); assert.equal(f.view, null)
  assert.equal((f.events[0] as any).outcome, "expired"); assert.equal(f.dispatched, 0)
  const reservation = other.request(); assert.equal(reservation.ack.outcome, "confirming")
  f.time.advance(BUNDLES_PLAN_MS); reservation.afterAck(); await flush()
  assert.equal(other.view, null); assert.equal((other.events[0] as any).outcome, "expired")
})

test("elapsed deadlines refuse with expired even before a delayed timer callback runs", async () => {
  for (const action of ["confirm", "cancel"] as const) {
    const f = fixture(); await f.open(); const plan = f.view!.planID
    f.time.at += BUNDLES_CONFIRMATION_MS // Busy event loop: the activation races a delayed timer.
    f.lifecycle[action](f.owner, plan); await flush()
    assert.equal(f.dispatched, 0); assert.equal((f.events[0] as any).outcome, "expired")
  }
})

test("sliding rates survive new mounts/digests; explicit remount only resets cutoff, not budgets", async () => {
  const f = fixture()
  for (let i = 0; i < 60; i++) assert.equal(f.lifecycle.budget.take(f.owner.extension, "read"), true)
  assert.equal(f.lifecycle.budget.take(f.owner.extension, "read"), false)
  for (let i = 0; i < 3; i++) { await f.open(); f.lifecycle.cancel(f.owner, f.view!.planID) }
  assert.equal(f.request().ack.outcome, "busy")
  const remounted = fixture(f.time, f.lifecycle, f.owner.extension, "b".repeat(64))
  assert.equal(remounted.request().ack.outcome, "busy")
  f.lifecycle.resetCutoffForUserRemount(f.owner.extension)
  for (let i = 0; i < 5; i++) { await remounted.open(); f.lifecycle.cancel(remounted.owner, remounted.view!.planID); f.lifecycle.resetCutoffForUserRemount(f.owner.extension) }
  assert.equal(remounted.request().ack.outcome, "busy", "ten manage attempts including busy attempts exhaust budget")
  assert.equal(f.lifecycle.budget.take(f.owner.extension, "read"), false, "reset never resets read rate")
  f.time.advance(60_000)
  assert.equal(f.lifecycle.budget.take(f.owner.extension, "read"), true)
  assert.equal(remounted.request().ack.outcome, "confirming")
})

test("cancellation window is sliding and cutoff naturally ends after five minutes", async () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) { await f.open(); f.lifecycle.cancel(f.owner, f.view!.planID) }
  f.time.advance(299_999); assert.equal(f.request().ack.outcome, "busy")
  f.time.advance(1); assert.equal(f.request().ack.outcome, "confirming"); f.lifecycle.dispose()
  const g = fixture()
  for (let i = 0; i < 3; i++) { await g.open(); g.lifecycle.cancel(g.owner, g.view!.planID); g.time.advance(60_000) }
  assert.equal(g.request().ack.outcome, "confirming"); g.lifecycle.dispose()
})

test("actual store authority revokes at mutation admission, before async queue/persistence; preferences preserve it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundles-lifecycle-"))
  try {
    const store = new PanelExtensionStore(directory), digest = "a".repeat(64), id = "fixture.manage"
    const pkg = { digest, html: "<p>Fixture</p>", manifest: { id, name: "Fixture", version: "1.0.0", apiVersion: 4 as const,
      author: "Fixture", license: "MIT", repository: "https://github.com/fixture/manage",
      permissions: ["session.context", "bundles.read", "bundles.manage", "panel.preferences"] as ["session.context", "bundles.read", "bundles.manage", "panel.preferences"] } }
    await store.install(pkg); await store.activate(id, digest, true)
    const lease = await store.captureMutationAuthority(id, digest)
    await store.setPreferences(id, digest, { view: "list" }); await lease.revalidate()
    const write = store.activate(id, digest, false)
    assert.throws(() => lease.assertCurrent()); assert.equal(lease.signal.aborted, true)
    await write; await assert.rejects(() => lease.revalidate()); lease.dispose()
    await store.activate(id, digest, true)
    for (const mutate of [() => store.install({ ...pkg, digest: "b".repeat(64) }, digest), () => store.remove(id, "b".repeat(64))]) {
      const current = (await store.list())[0]!; if (!current.enabled) await store.activate(id, current.digest, true)
      const lease = await store.captureMutationAuthority(id, current.digest), pending = mutate()
      assert.throws(() => lease.assertCurrent()); await pending; lease.dispose()
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("checked confirmation consumes before its first fresh await, rejects stale admission and emits one terminal", async () => {
  const f = fixture(); let release!: () => void
  f.prepared.readTarget = async () => { await new Promise<void>(resolve => { release = resolve }); return { ...initial, documentDigest: "changed" } }
  await f.open(); f.time.advance(600); const plan = f.view!.planID
  const first = f.lifecycle.confirmChecked(f.owner, plan)
  const failed = assert.rejects(first, BundlesStalePlanError)
  await assert.rejects(f.lifecycle.confirmChecked(f.owner, plan), BundlesStalePlanError)
  await flush(); release(); await failed; await flush()
  assert.equal(f.dispatched, 0); assert.equal(f.events.length, 1)
  assert.equal((f.events[0] as any).outcome, "failed")
})

test("checked confirmation ends at admission, preserving one confirmed terminal across uncertain native completion", async () => {
  const f = fixture(); let release!: () => void, submissions = 0
  f.prepared.dispatch = async (authority, submitted) => {
    authority.assertCurrent(); submissions++; submitted()
    await new Promise<void>(resolve => { release = resolve })
    throw new Error("uncertain after native submission")
  }
  await f.open(); f.time.advance(600); const plan = f.view!.planID
  await f.lifecycle.confirmChecked(f.owner, plan)
  assert.equal(submissions, 1); assert.equal((f.events[0] as any).outcome, "confirmed")
  release(); await flush()
  assert.equal(f.events.length, 1)
  await assert.rejects(f.lifecycle.confirmChecked(f.owner, plan), BundlesStalePlanError)
  f.lifecycle.confirm(f.owner, plan); await flush()
  assert.equal(submissions, 1); assert.equal(f.events.length, 1)
})

test("checked admission unwinds caller cancellation while ignored late native reads retain their fences", async () => {
  const f = fixture(), caller = new AbortController(); let release!: () => void
  f.prepared.readTarget = async () => { await new Promise<void>(resolve => { release = resolve }); return initial }
  await f.open(); f.time.advance(600)
  const result = f.lifecycle.confirmChecked(f.owner, f.view!.planID, caller.signal)
  const failed = assert.rejects(result, BundlesStalePlanError)
  await flush(); caller.abort(); await failed
  release(); await flush()
  assert.equal(f.dispatched, 0); assert.equal(f.events.length, 1)
  assert.equal((f.events[0] as any).outcome, "failed")
})
