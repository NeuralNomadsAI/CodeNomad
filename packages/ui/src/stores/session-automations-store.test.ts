import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SessionAutomation, SessionAutomationsResponse } from "../../../server/src/opencode/automation-contract"
import { HttpResponseError } from "../lib/retryable-file-search.ts"
import { createSessionAutomationsStore, formatAutomationMutationError } from "./session-automations-store.ts"

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

  it("polls only active code-action event triggers while demanded and stops when paused or for prompt/shell events", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const f = fixture()
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.resolve({
      status: "ok",
      automations: [automation("aut_evt", {
        status: "active",
        trigger: { type: "event", server: "github", event: "push" },
        action: { type: "code", code: "return {}" },
        nextDueAt: undefined,
        runCount: 0,
      })],
    })
    await Promise.resolve()
    await Promise.resolve()

    t.mock.timers.tick(15_000)
    assert.equal(f.reads.length, 2, "polls active code-action event trigger while Status is shown")
    f.reads[1]!.resolve({
      status: "ok",
      automations: [automation("aut_evt_shell", {
        status: "active",
        trigger: { type: "event", server: "github", event: "push" },
        action: { type: "shell", command: "npm test" },
        nextDueAt: undefined,
        runCount: 1,
      })],
    })
    await Promise.resolve()
    await Promise.resolve()

    t.mock.timers.tick(60_000)
    assert.equal(f.reads.length, 2, "does not poll shell or prompt event triggers that refresh on native events")
    release()
  })

  it("evicts snapshots on last release and polls boundedly for done one-shot shell automations awaiting output", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const authority = new AbortController()
    const f = fixture({ signal: () => authority.signal })
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.resolve({
      status: "ok",
      automations: [automation("aut_shell", {
        status: "done",
        trigger: { type: "at", at: "2026-11-27T12:00:00Z", tz: "UTC" },
        action: { type: "shell", command: "sleep 30 && echo ok" },
        nextDueAt: undefined,
        lastOutcome: undefined,
        lastOutput: undefined,
        runCount: 1,
      })],
    })
    await Promise.resolve()
    await Promise.resolve()

    t.mock.timers.tick(15_000)
    assert.equal(f.reads.length, 2, "schedules bounded follow-up for one-shot shell missing outcome/output")
    f.reads[1]!.resolve({
      status: "ok",
      automations: [automation("aut_shell", {
        status: "done",
        trigger: { type: "at", at: "2026-11-27T12:00:00Z", tz: "UTC" },
        action: { type: "shell", command: "sleep 30 && echo ok" },
        nextDueAt: undefined,
        lastOutcome: "fired",
        lastOutput: "ok",
        runCount: 1,
      })],
    })
    await Promise.resolve()
    await Promise.resolve()
    t.mock.timers.tick(60_000)
    assert.equal(f.reads.length, 2, "stops follow-up once shell outcome/output are populated")

    release()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "loading" }, "evicts snapshot on last release")
    authority.abort()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "loading" }, "evicted snapshot stays absent after detach")
  })

  it("keeps future due times scheduled even after another overdue automation exhausts retries", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    let clock = 1_000_000
    const f = fixture({ now: () => clock })
    const release = f.store.demand("i", "ses_a")
    const both = {
      status: "ok" as const,
      automations: [
        automation("aut_overdue", { nextDueAt: clock - 10_000 }),
        automation("aut_future", { nextDueAt: clock + 120_000 }),
      ],
    }
    f.reads[0]!.resolve(both)
    await Promise.resolve()
    await Promise.resolve()

    // Exhaust the 3 overdue backoff checks (15s + 30s + 45s = 90s).
    for (const [step, expectedReads] of [[15_000, 2], [30_000, 3], [45_000, 4]] as const) {
      clock += step
      t.mock.timers.tick(step)
      assert.equal(f.reads.length, expectedReads)
      f.reads[expectedReads - 1]!.resolve(both)
      await Promise.resolve()
      await Promise.resolve()
    }

    // 30s left until aut_future (120s total) + 1.5s grace = 31.5s.
    clock += 31_400
    t.mock.timers.tick(31_400)
    assert.equal(f.reads.length, 4)
    clock += 100
    t.mock.timers.tick(100)
    assert.equal(f.reads.length, 5, "still refreshes when the later future automation becomes due")
    release()
  })

  it("localizes fixed route errors while preserving genuine upstream error messages", () => {
    const fallback = "Impossible de mettre à jour l'automatisation"
    const notFound = new HttpResponseError("Automation not found", 404, null, undefined, {
      status: "error",
      error: "Automation not found",
    })
    const upstream = new HttpResponseError("Upstream lock active", 502, null, undefined, {
      status: "error",
      error: "Upstream lock active",
      upstream: true,
    })
    assert.equal(formatAutomationMutationError(notFound, fallback), fallback)
    assert.equal(formatAutomationMutationError(upstream, fallback), "Upstream lock active")
    assert.equal(formatAutomationMutationError(new Error("Network error"), fallback), fallback)
  })

  it("keeps later future deadlines scheduled even after transient read failures exhaust retries", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    let clock = 1_000_000
    const f = fixture({ now: () => clock })
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.resolve({
      status: "ok",
      automations: [
        automation("aut_soon", { nextDueAt: clock + 10_000 }),
        automation("aut_later", { nextDueAt: clock + 300_000 }),
      ],
    })
    await Promise.resolve()
    await Promise.resolve()

    // First due fires at +11.5s and fails, followed by 3 retry failures (15s + 30s + 45s = 90s).
    clock += 11_500
    t.mock.timers.tick(11_500)
    assert.equal(f.reads.length, 2)
    f.reads[1]!.resolve({ status: "unavailable" })
    await Promise.resolve()
    await Promise.resolve()

    for (const [step, expectedReads] of [[15_000, 3], [30_000, 4], [45_000, 5]] as const) {
      clock += step
      t.mock.timers.tick(step)
      assert.equal(f.reads.length, expectedReads)
      f.reads[expectedReads - 1]!.resolve({ status: "unavailable" })
      await Promise.resolve()
      await Promise.resolve()
    }

    // Remaining time to aut_later (300s total, 101.5s elapsed -> 198.5s + 1.5s grace = 200s).
    clock += 199_900
    t.mock.timers.tick(199_900)
    assert.equal(f.reads.length, 5)
    clock += 100
    t.mock.timers.tick(100)
    assert.equal(f.reads.length, 6, "still refreshes when the later automation becomes due after recovery")
    release()
  })

  it("refreshes shell automations on shell.exited with one short follow-up when persistence lags", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const f = fixture()
    const releaseShell = f.store.demand("i", "ses_shell")
    const releasePrompt = f.store.demand("i", "ses_prompt")
    const initialShell = automation("aut_shell", {
      status: "active",
      action: { type: "shell", command: "npm test" },
      nextDueAt: Date.now() + 3_600_000,
      runCount: 2,
      lastOutcome: "fired",
      lastOutput: "previous run",
      updatedAt: 100,
    })
    f.reads[0]!.resolve({ status: "ok", automations: [initialShell] })
    f.reads[1]!.resolve({ status: "ok", automations: [automation("aut_prompt")] })
    await Promise.resolve()
    await Promise.resolve()

    // shell.exited refreshes only the session with a shell automation.
    const exitRefresh = f.store.noteShellExited("i")
    assert.equal(f.reads.length, 3, "skips sessions without shell automations")
    assert.equal(f.reads[2]!.sessionId, "ses_shell")
    // Immediate read still sees pre-commit state -> triggers one 1.5s follow-up.
    f.reads[2]!.resolve({ status: "ok", automations: [initialShell] })
    await exitRefresh
    t.mock.timers.tick(1_500)
    assert.equal(f.reads.length, 4, "runs one follow-up refresh when result was not persisted yet")
    f.reads[3]!.resolve({
      status: "ok",
      automations: [{ ...initialShell, lastOutput: "new run green", updatedAt: 200 }],
    })
    await Promise.resolve()
    await Promise.resolve()
    t.mock.timers.tick(10_000)
    assert.equal(f.reads.length, 4, "no extra polling after follow-up settles")

    releaseShell()
    releasePrompt()
  })

  it("ignores paused or completed shell automations and coalesces rapid shell.exited bursts", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const f = fixture()
    const releaseDone = f.store.demand("i", "ses_done")
    const releasePaused = f.store.demand("i", "ses_paused")
    const releaseActive = f.store.demand("i", "ses_active")
    const doneShell = automation("aut_done", {
      status: "done",
      action: { type: "shell", command: "npm test" },
      lastOutcome: "fired",
      lastOutput: "ok",
    })
    const pausedShell = automation("aut_paused", {
      status: "paused",
      action: { type: "shell", command: "npm test" },
    })
    const activeShell = automation("aut_active", {
      status: "active",
      action: { type: "shell", command: "npm test" },
      nextDueAt: Date.now() + 3_600_000,
    })
    f.reads[0]!.resolve({ status: "ok", automations: [doneShell] })
    f.reads[1]!.resolve({ status: "ok", automations: [pausedShell] })
    f.reads[2]!.resolve({ status: "ok", automations: [activeShell] })
    await Promise.resolve()
    await Promise.resolve()

    const firstExit = f.store.noteShellExited("i")
    assert.equal(f.reads.length, 4, "skips paused and already-finished shell automations")
    assert.equal(f.reads[3]!.sessionId, "ses_active")
    f.reads[3]!.resolve({ status: "ok", automations: [activeShell] })
    await firstExit

    // A second unrelated shell.exited while the 1.5s settle follow-up is armed coalesces into that timer.
    await f.store.noteShellExited("i")
    assert.equal(f.reads.length, 4, "does not fire another immediate read while follow-up is armed")
    t.mock.timers.tick(1_500)
    assert.equal(f.reads.length, 5, "fires the single coalesced follow-up")
    f.reads[4]!.resolve({ status: "ok", automations: [activeShell] })
    await Promise.resolve()

    releaseDone()
    releasePaused()
    releaseActive()
  })
})
