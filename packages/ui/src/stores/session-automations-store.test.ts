import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SessionAutomation, SessionAutomationsResponse } from "../../../server/src/opencode/automation-contract"
import { createSessionAutomationsStore } from "./session-automations-store.ts"

const automation = (id: string, overrides: Partial<SessionAutomation> = {}): SessionAutomation => ({
  id,
  name: `Automation ${id}`,
  status: "active",
  trigger: { type: "every", every: "5 minutes", tz: "UTC" },
  tz: "UTC",
  action: { type: "prompt", prompt: "Check build" },
  runCount: 1,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
})

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(options: { now?: () => number; signal?: (instanceId: string) => AbortSignal | undefined } = {}) {
  const reads: Array<{ instanceId: string; sessionId: string; signal: AbortSignal } & ReturnType<typeof deferred<SessionAutomationsResponse>>> = []
  const store = createSessionAutomationsStore((instanceId, sessionId, signal) => {
    const read = { instanceId, sessionId, signal, ...deferred<SessionAutomationsResponse>() }
    reads.push(read)
    return read.promise
  }, options)
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { store, reads, settle }
}

describe("session automations store", () => {
  it("reads on demand only, coalesces refreshes and aborts on release", async () => {
    const f = fixture()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "loading" })
    await f.store.refresh("i", "ses_a")
    assert.equal(f.reads.length, 0)

    const release = f.store.demand("i", "ses_a")
    assert.equal(f.reads.length, 1)
    f.store.refresh("i", "ses_a")
    f.store.refresh("i", "ses_a")
    assert.equal(f.reads.length, 1, "one read in flight at a time")

    f.reads[0]!.resolve({ status: "ok", automations: [automation("aut_1")] })
    await f.settle()
    assert.equal(f.reads.length, 2, "one coalesced trailing follow-up")
    assert.equal(f.store.state("i", "ses_a").status, "ok")

    release()
    assert.equal(f.reads[1]!.signal.aborted, true, "releasing demand aborts the trailing read")
    await f.store.refreshDemanded("i")
    assert.equal(f.reads.length, 2)
  })

  it("preserves the last good snapshot on failure and settles unsupported cleanly", async () => {
    const f = fixture()
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.reject(new Error("offline"))
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "unavailable" })

    f.store.refresh("i", "ses_a")
    const list = [automation("aut_1")]
    f.reads[1]!.resolve({ status: "ok", automations: list })
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "ok", automations: list })

    f.store.refresh("i", "ses_a")
    f.reads[2]!.resolve({ status: "unavailable" })
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "ok", automations: list })

    f.store.refresh("i", "ses_a")
    f.reads[3]!.resolve({ status: "unsupported" })
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "unsupported" })
    release()
  })

  it("isolates busy state per automation and refreshes once the action settles", async () => {
    const f = fixture()
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.resolve({ status: "ok", automations: [automation("aut_1"), automation("aut_2")] })
    await f.settle()

    const gate = deferred<void>()
    let runs = 0
    const first = f.store.run("i", "ses_a", "aut_1", async () => { runs++; await gate.promise })
    assert.equal(f.store.busy("i", "ses_a", "aut_1"), true)
    assert.equal(f.store.busy("i", "ses_a", "aut_2"), false)

    await f.store.run("i", "ses_a", "aut_1", async () => { runs++ })
    assert.equal(runs, 1, "concurrent action on same automation is ignored")

    gate.resolve()
    await f.settle()
    assert.equal(f.store.busy("i", "ses_a", "aut_1"), true, "stays busy until post-action refresh settles")
    assert.equal(f.reads.length, 2, "refreshes after action settles")
    f.reads[1]!.resolve({ status: "ok", automations: [automation("aut_1"), automation("aut_2")] })
    await first
    assert.equal(f.store.busy("i", "ses_a", "aut_1"), false)
    release()
  })

  it("applies confirmed mutation patches immediately and fences pre-mutation in-flight reads", async () => {
    const f = fixture()
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.resolve({ status: "ok", automations: [automation("aut_1"), automation("aut_2")] })
    await f.settle()

    // Start a read before the mutation runs.
    const staleRefresh = f.store.refresh("i", "ses_a")
    assert.equal(f.reads.length, 2)

    const runPromise = f.store.run("i", "ses_a", "aut_1", async () => (items => items.filter(item => item.id !== "aut_1")))
    await f.settle()
    // Confirmed deletion is visible immediately, before the stale read settles.
    const patched = f.store.state("i", "ses_a")
    assert.equal(patched.status, "ok")
    assert.deepEqual(patched.automations.map(item => item.id), ["aut_2"])

    // Resolve the pre-mutation read with stale data containing aut_1: it must be fenced.
    f.reads[1]!.resolve({ status: "ok", automations: [automation("aut_1"), automation("aut_2")] })
    await f.settle()
    const afterStale = f.store.state("i", "ses_a")
    assert.equal(afterStale.status, "ok")
    assert.deepEqual(afterStale.automations.map(item => item.id), ["aut_2"], "stale read cannot resurrect deleted row")
    assert.equal(f.reads.length, 3, "starts a post-mutation trailing read")

    // Even if the post-mutation refresh fails transiently, the deleted row stays removed.
    f.reads[2]!.resolve({ status: "unavailable" })
    await Promise.all([staleRefresh, runPromise])
    const finalState = f.store.state("i", "ses_a")
    assert.equal(finalState.status, "ok")
    assert.deepEqual(finalState.automations.map(item => item.id), ["aut_2"])
    assert.equal(f.store.busy("i", "ses_a", "aut_1"), false)
    release()
  })

  it("retries transient due-time read failures with bounded backoff while demanded", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    let now = 10_000
    const f = fixture({ now: () => now })
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.resolve({
      status: "ok",
      automations: [automation("aut_active", { status: "active", nextDueAt: 15_000, runCount: 1 })],
    })
    await Promise.resolve()
    await Promise.resolve()

    // Due-time refresh fires and fails transiently.
    now = 16_600
    t.mock.timers.tick(6_600)
    assert.equal(f.reads.length, 2)
    f.reads[1]!.resolve({ status: "unavailable" })
    await Promise.resolve()
    await Promise.resolve()

    // Retry fires after 15s backoff and recovers the finished automation.
    now = 31_600
    t.mock.timers.tick(15_000)
    assert.equal(f.reads.length, 3, "schedules bounded retry after transient failure")
    f.reads[2]!.resolve({
      status: "ok",
      automations: [automation("aut_active", { status: "done", nextDueAt: undefined, runCount: 2 })],
    })
    await Promise.resolve()
    await Promise.resolve()
    const recovered = f.store.state("i", "ses_a")
    assert.equal(recovered.status, "ok")
    assert.equal(recovered.automations[0]?.status, "done")
    assert.equal(recovered.automations[0]?.runCount, 2)
    release()
  })

  it("schedules one targeted refresh after the earliest active nextDueAt and cancels on release", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    let now = 10_000
    const f = fixture({ now: () => now })
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.resolve({
      status: "ok",
      automations: [
        automation("aut_paused", { status: "paused", nextDueAt: 11_000 }),
        automation("aut_active", { status: "active", nextDueAt: 15_000 }),
      ],
    })
    await Promise.resolve()
    await Promise.resolve()
    // 5000ms remaining + 1500ms grace = 6500ms
    now = 16_000
    t.mock.timers.tick(6_000)
    assert.equal(f.reads.length, 1)
    now = 16_600
    t.mock.timers.tick(600)
    assert.equal(f.reads.length, 2, "fires once after earliest active nextDueAt + grace")

    // Releasing demand cancels any scheduled timer.
    f.reads[1]!.resolve({ status: "ok", automations: [automation("aut_active", { nextDueAt: 25_000 })] })
    await Promise.resolve()
    await Promise.resolve()
    release()
    now = 40_000
    t.mock.timers.tick(20_000)
    assert.equal(f.reads.length, 2, "released demand never fires a timer refresh")
  })

  it("drops cached snapshots when attachment authority is revoked or replaced", async () => {
    let authority = new AbortController()
    const f = fixture({ signal: () => authority.signal })
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.resolve({
      status: "ok",
      automations: [automation("aut_secret", { action: { type: "prompt", prompt: "Secret from backend A" } })],
    })
    await f.settle()
    assert.equal(f.store.state("i", "ses_a").status, "ok")

    // Detach backend A and replace with backend B that returns unavailable.
    authority.abort()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "loading" }, "revoked attachment drops stale snapshot")
    authority = new AbortController()
    const refreshPromise = f.store.refresh("i", "ses_a")
    assert.equal(f.reads.length, 2)
    f.reads[1]!.resolve({ status: "unavailable" })
    await refreshPromise
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "unavailable" }, "replacement never inherits old backend prompt")
    release()
  })

  it("refreshes active event-triggered automations while demanded and stops when paused or released", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const f = fixture()
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.resolve({
      status: "ok",
      automations: [automation("aut_evt", {
        status: "active",
        trigger: { type: "event", server: "github", event: "push" },
        action: { type: "shell", command: "npm test" },
        nextDueAt: undefined,
        runCount: 0,
      })],
    })
    await Promise.resolve()
    await Promise.resolve()

    t.mock.timers.tick(15_000)
    assert.equal(f.reads.length, 2, "polls active event-triggered automation while Status is shown")
    f.reads[1]!.resolve({
      status: "ok",
      automations: [automation("aut_evt", {
        status: "paused",
        trigger: { type: "event", server: "github", event: "push" },
        action: { type: "shell", command: "npm test" },
        nextDueAt: undefined,
        runCount: 1,
      })],
    })
    await Promise.resolve()
    await Promise.resolve()

    t.mock.timers.tick(60_000)
    assert.equal(f.reads.length, 2, "stops polling once event-triggered automation is paused")
    release()
  })
})
