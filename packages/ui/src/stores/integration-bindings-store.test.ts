import assert from "node:assert/strict"
import { test } from "node:test"
import type { IntegrationBindingResponse } from "../../../server/src/integration-types"
import { createIntegrationBindingsStore, type IntegrationBindingTarget } from "./integration-bindings-store"

const target: IntegrationBindingTarget = { instanceId: "i", directory: "/repo", sessionID: "ses_a", integrationId: "blender" }
const attached: IntegrationBindingResponse = { state: "attached", label: "Scene" }
const settle = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  let now = 0
  const timers = new Set<{ at: number; callback: () => void }>()
  const reads: Array<{ target: IntegrationBindingTarget; signal: AbortSignal; resolve: (value: IntegrationBindingResponse) => void; reject: (error: Error) => void }> = []
  const store = createIntegrationBindingsStore((target, signal) => new Promise((resolve, reject) => reads.push({ target, signal, resolve, reject })), {
    setTimer(callback, ms) { const timer = { at: now + ms, callback }; timers.add(timer); return timer },
    clearTimer(timer) { timers.delete(timer as { at: number; callback: () => void }) },
  })
  const advance = async (ms: number) => {
    now += ms
    for (const timer of timers) if (timer.at <= now) { timers.delete(timer); timer.callback() }
    await settle()
  }
  return { store, reads, timers, advance }
}

test("binding demands share exactly one live target; release/navigation fence pending reads and retain no authority", async () => {
  const f = fixture()
  const release = f.store.demand(target), sibling = f.store.demand(target)
  assert.equal(f.reads.length, 1)
  release()
  assert.equal(f.reads[0]!.signal.aborted, false)
  sibling()
  assert.equal(f.reads[0]!.signal.aborted, true)
  const other = { ...target, sessionID: "ses_b", directory: "/worktree" }
  const next = f.store.demand(other)
  f.reads[0]!.resolve(attached)
  f.reads[1]!.resolve({ state: "none" })
  await settle()
  assert.deepEqual(f.store.state(target), { state: "unknown" })
  assert.deepEqual(f.store.state(other), { state: "none" })
  const again = f.store.demand(target)
  assert.deepEqual(f.store.state(target), { state: "unknown" })
  again(); next()
})

test("invalidation revokes at once, fences replies before the 300ms boundary and has one trailing followup", async () => {
  const f = fixture(), release = f.store.demand(target)
  f.reads[0]!.resolve(attached); await settle()
  for (let i = 0; i < 10; i++) f.store.applyEvent("i", "rpc.neuralnomads.blender.status_changed")
  assert.deepEqual(f.store.state(target), { state: "unknown" })
  await f.advance(299)
  assert.equal(f.reads.length, 1)
  await f.advance(1)
  assert.equal(f.reads.length, 2)
  for (let i = 0; i < 10; i++) f.store.applyEvent("i", "config.updated")
  f.reads[1]!.resolve(attached); await settle()
  assert.deepEqual(f.store.state(target), { state: "unknown" }, "the invalidated reply never revives attached")
  await f.advance(300)
  assert.equal(f.reads.length, 3)
  for (let i = 0; i < 10; i++) f.store.applyEvent("i", "plugin.updated")
  await f.advance(300)
  assert.equal(f.reads.length, 3)
  f.reads[2]!.resolve(attached); await settle()
  assert.equal(f.reads.length, 4)
  f.reads[3]!.reject(new Error("private native failure")); await settle()
  assert.deepEqual(f.store.state(target), { state: "unknown" }, "read failure never keeps attached")
  await f.advance(60_000)
  assert.equal(f.reads.length, 4, "no polling")
  release()
})

test("exact-session changes, reconnect/open/disconnect and stopped-instance generations reconcile only demanded targets", async () => {
  const f = fixture(), release = f.store.demand(target)
  f.reads[0]!.resolve(attached); await settle()
  f.store.applyEvent("other", "plugin.updated")
  f.store.applyEvent("i", "session.updated", "ses_other")
  await f.advance(300)
  assert.equal(f.reads.length, 1)
  for (const event of ["session.updated", "session.moved", "session.deleted"]) {
    f.store.applyEvent("i", event, target.sessionID)
    assert.equal(f.store.state(target).state, "unknown")
    await f.advance(300)
    f.reads.at(-1)!.resolve(attached); await settle()
  }
  f.store.reconnect("i", false)
  assert.equal(f.store.state(target).state, "unknown")
  assert.equal(f.reads.length, 4)
  f.store.reconnect("i")
  f.store.reconnect()
  f.reads[4]!.resolve(attached); await settle()
  assert.equal(f.store.state(target).state, "unknown")
  f.reads[5]!.resolve({ state: "none" }); await settle()
  assert.equal(f.store.state(target).state, "none")
  f.store.clearInstance("i")
  const reopened = f.store.demand(target)
  release()
  f.reads[6]!.resolve(attached); await settle()
  assert.equal(f.store.state(target).state, "attached", "an old release cannot erase a reopened demand")
  reopened()
})

test("mutation finally reconciles its captured target after failure, never replays or refreshes an unshown session", async () => {
  const f = fixture(), release = f.store.demand(target)
  f.reads[0]!.resolve(attached); await settle()
  let finish!: () => void, dispatches = 0
  const mutation = f.store.run(target, async () => { dispatches++; await new Promise<void>(resolve => { finish = resolve }); throw Error("uncertain") })
  assert.equal(f.store.state(target).state, "unknown")
  await f.store.run(target, async () => { dispatches++ })
  assert.equal(dispatches, 1)
  finish()
  await assert.rejects(mutation)
  assert.equal(f.reads.length, 2)
  f.reads[1]!.resolve(attached); await settle()
  const pending = f.store.run(target, async () => { dispatches++; await new Promise<void>(resolve => { finish = resolve }) })
  release()
  const other = { ...target, sessionID: "ses_other" }
  const next = f.store.demand(other)
  finish(); await pending
  assert.equal(f.reads.length, 3)
  assert.deepEqual(f.reads[2]!.target, other)
  assert.equal(dispatches, 2)
  next()
})

for (const scope of ["native", "renderer"] as const) test(`${scope} disconnect cancels dirty trailing reads and suspends events/new demand until reconnect`, async () => {
  const f = fixture(), release = f.store.demand(target)
  f.reads[0]!.resolve(attached); await settle()
  f.store.applyEvent("i", "plugin.updated"); await f.advance(300)
  f.store.applyEvent("i", "config.updated"); await f.advance(300)
  f.store.reconnect(scope === "native" ? "i" : undefined, false)
  assert.equal(f.reads[1]!.signal.aborted, true)
  f.reads[1]!.resolve(attached); await settle()
  assert.equal(f.reads.length, 2, "aborted read cannot launch its dirty trailing request")
  assert.equal(f.store.state(target).state, "unknown")
  f.store.applyEvent("i", "rpc.neuralnomads.blender.status_changed")
  const other = { ...target, sessionID: "ses_other" }
  const next = f.store.demand(other)
  await f.advance(60_000)
  assert.equal(f.reads.length, 2, "disconnect suspends both invalidation and navigation reads")
  f.store.reconnect(scope === "native" ? "i" : undefined)
  assert.equal(f.reads.length, 4, "reconnect reconciles only the currently demanded identities")
  f.reads[2]!.resolve({ state: "none" }); f.reads[3]!.resolve(attached); await settle()
  assert.equal(f.store.state(target).state, "none")
  assert.equal(f.store.state(other).state, "attached")
  release(); next()
})
