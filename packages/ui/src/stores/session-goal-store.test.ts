import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { GoalState, SessionGoalResponse } from "../../../server/src/opencode/goal-contract"
import { BackgroundReadQueue } from "../lib/background-read-queue.ts"
import { createSessionGoalStore } from "./session-goal-store.ts"

const goal = (status: GoalState["status"], extra: Partial<GoalState> = {}): GoalState => ({
  id: "g1", objective: "Ship the release", status, rounds: 2, maxRounds: 50, updatedAt: 1, ...extra,
})
const found = (value: GoalState | null): SessionGoalResponse => ({ status: "goal", goal: value })

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** A store whose reads wait until the test answers them. */
function fixture() {
  const reads: Array<{ instanceId: string; sessionId: string; signal: AbortSignal } & ReturnType<typeof deferred<SessionGoalResponse>>> = []
  const store = createSessionGoalStore((instanceId, sessionId, signal) => {
    const read = { instanceId, sessionId, signal, ...deferred<SessionGoalResponse>() }
    reads.push(read)
    return read.promise
  })
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { store, reads, settle }
}

describe("session goal store", () => {
  it("reads on demand only, shows loading until the first answer and tracks only demanded sessions", async () => {
    const f = fixture()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "loading" })
    await f.store.refresh("i", "ses_a")
    assert.equal(f.reads.length, 0, "an untracked session is never read")
    f.store.applyChanged("i", { sessionID: "ses_a", goal: goal("active") })
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "loading" }, "untracked changes are ignored")

    const release = f.store.demand("i", "ses_a")
    assert.equal(f.reads.length, 1)
    f.reads[0]!.resolve(found(goal("active")))
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), found(goal("active")))
    release()
    release()
    await f.store.refreshDemanded("i")
    assert.equal(f.reads.length, 1, "a released session is not re-read on reconnect")
  })

  it("coalesces refreshes into one trailing read and never publishes a reply older than a heard change", async () => {
    const f = fixture()
    f.store.demand("i", "ses_a")
    f.store.refresh("i", "ses_a")
    f.store.refresh("i", "ses_a")
    assert.equal(f.reads.length, 1, "one read at a time")
    // The change arrives while the first read is in flight: its reply is older.
    f.store.applyChanged("i", { sessionID: "ses_a", goal: goal("paused", { reason: "Paused by the user" }) })
    f.reads[0]!.resolve(found(goal("active")))
    await f.settle()
    assert.equal(f.reads.length, 2, "the coalesced demand runs once after the first read")
    assert.deepEqual(f.store.state("i", "ses_a"), found(goal("paused", { reason: "Paused by the user" })))
    // The trailing read started after the change, so it is newer and publishes.
    f.reads[1]!.resolve(found(null))
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), found(null))
    assert.equal(f.reads.length, 2)
  })

  it("keeps the last goal shown when a read fails, and settles a first failure as unavailable or unsupported", async () => {
    const f = fixture()
    f.store.demand("i", "ses_a")
    f.reads[0]!.reject(new Error("offline"))
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "unavailable" })
    f.store.refresh("i", "ses_a")
    f.reads[1]!.resolve({} as SessionGoalResponse)
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "unavailable" }, "a malformed answer is a failure")
    f.store.refresh("i", "ses_a")
    f.reads[2]!.resolve(found(goal("active")))
    await f.settle()
    for (const failure of [() => f.reads.at(-1)!.reject(new Error("offline")), () => f.reads.at(-1)!.resolve({ status: "unavailable" })]) {
      f.store.refresh("i", "ses_a")
      failure()
      await f.settle()
      assert.deepEqual(f.store.state("i", "ses_a"), found(goal("active")))
    }
    // A runtime without the RPC is an answer, not a failure: nothing is shown.
    f.store.refresh("i", "ses_a")
    f.reads.at(-1)!.resolve({ status: "unsupported" })
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "unsupported" })
  })

  it("applies valid changes, asks again for unreadable ones and ignores other sessions", async () => {
    const f = fixture()
    f.store.demand("i", "ses_a")
    f.reads[0]!.resolve(found(goal("active")))
    await f.settle()
    f.store.applyChanged("i", { sessionID: "ses_b", goal: goal("complete") })
    f.store.applyChanged("other", { sessionID: "ses_a", goal: null })
    f.store.applyChanged("i", null)
    assert.deepEqual(f.store.state("i", "ses_a"), found(goal("active")))
    assert.equal(f.reads.length, 1)
    f.store.applyChanged("i", { sessionID: "ses_a", goal: { ...goal("active"), status: "blocked" } })
    assert.equal(f.reads.length, 2, "a change that cannot be read is re-read")
    f.reads[1]!.resolve(found(goal("complete", { reason: "Done" })))
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), found(goal("complete", { reason: "Done" })))
    f.store.applyChanged("i", { sessionID: "ses_a", goal: null })
    assert.deepEqual(f.store.state("i", "ses_a"), found(null))
  })

  it("re-reads demanded sessions after a reconnect and drops forgotten or stopped ones, fencing their late replies", async () => {
    const f = fixture()
    f.store.demand("i", "ses_a")
    f.store.demand("i", "ses_b")
    f.store.demand("j", "ses_c")
    for (const read of f.reads.splice(0)) read.resolve(found(goal("active")))
    await f.settle()
    await Promise.race([f.store.refreshDemanded("i"), f.settle()])
    assert.deepEqual(f.reads.map(read => read.sessionId), ["ses_a", "ses_b"])
    f.store.forget("i", "ses_a")
    f.store.clearInstance("i")
    assert.deepEqual(f.reads.map(read => read.signal.aborted), [true, true], "dropped sessions' reads are aborted")
    for (const read of f.reads.splice(0)) read.resolve(found(goal("paused")))
    await f.settle()
    assert.deepEqual(f.store.state("i", "ses_a"), { status: "loading" })
    assert.deepEqual(f.store.state("i", "ses_b"), { status: "loading" })
    assert.deepEqual(f.store.state("j", "ses_c"), found(goal("active")))
    await Promise.race([f.store.refreshDemanded(), f.settle()])
    assert.deepEqual(f.reads.map(read => read.sessionId), ["ses_c"])
  })

  it("runs one command at a time per session and reads its outcome afterwards", async () => {
    const f = fixture()
    f.store.demand("i", "ses_a")
    f.reads[0]!.resolve(found(goal("active")))
    await f.settle()
    const command = deferred<void>()
    let runs = 0
    const first = f.store.run("i", "ses_a", () => { runs++; return command.promise })
    assert.equal(f.store.busy("i", "ses_a"), true)
    assert.equal(f.store.busy("i", "ses_b"), false)
    await f.store.run("i", "ses_a", async () => { runs++ })
    assert.equal(runs, 1, "a second command is refused while one is in flight")
    command.resolve()
    await first
    assert.equal(f.store.busy("i", "ses_a"), false)
    assert.equal(f.reads.length, 2, "the outcome is read after the command")
    const failing = f.store.run("i", "ses_a", async () => { throw new Error("No active goal to pause.") })
    await assert.rejects(failing, /No active goal/)
    assert.equal(f.store.busy("i", "ses_a"), false)
  })

  it("leaves a session hidden during its command unread, still applies its changes and reads it when shown again", async () => {
    const f = fixture()
    const release = f.store.demand("i", "ses_a")
    f.reads[0]!.resolve(found(goal("active")))
    await f.settle()
    const command = deferred<void>()
    const running = f.store.run("i", "ses_a", () => command.promise)
    release()
    command.resolve()
    await running
    await f.settle()
    assert.equal(f.reads.length, 1, "no outcome read for a hidden session")
    f.store.applyChanged("i", { sessionID: "ses_a", goal: goal("paused") })
    assert.deepEqual(f.store.state("i", "ses_a"), found(goal("paused")), "changes still reach a hidden session's snapshot")
    f.store.applyChanged("i", { sessionID: "ses_a", goal: { status: "unknown" } })
    f.store.refresh("i", "ses_a")
    assert.equal(f.reads.length, 1, "a hidden session is read on its next demand")
    f.store.demand("i", "ses_a")
    assert.equal(f.reads.length, 2)
    assert.deepEqual(f.store.state("i", "ses_a"), found(goal("paused")), "the last goal shows until the read answers")
  })

  it("aborts hidden sessions' queued and running reads, so rapid switching reads only the shown session", async () => {
    // The real shared budget, already busy with other background work.
    const queue = new BackgroundReadQueue(1)
    const blocker = deferred<void>()
    const background = queue.run(new AbortController().signal, () => blocker.promise)
    const dispatched: string[] = [], completed: string[] = []
    const requests = new Map<string, { signal: AbortSignal; answer: (value: SessionGoalResponse) => void }>()
    const store = createSessionGoalStore((_instanceId, sessionId, signal) => queue.run(signal, () => new Promise<SessionGoalResponse>((resolve, reject) => {
      dispatched.push(sessionId)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      requests.set(sessionId, { signal, answer: value => { completed.push(sessionId); resolve(value) } })
    }), "visible"))
    const settle = () => new Promise(resolve => setTimeout(resolve, 0))
    let release: (() => void) | undefined
    for (const sessionId of ["ses_1", "ses_2", "ses_3", "ses_4", "ses_5"]) {
      release?.()
      release = store.demand("i", sessionId)
      await settle()
    }
    assert.deepEqual(dispatched, [], "every read waits behind the busy budget")
    blocker.resolve()
    await background
    await settle()
    assert.deepEqual(dispatched, ["ses_5"], "hidden sessions' queued reads never dispatch")
    requests.get("ses_5")!.answer(found(goal("active")))
    await settle()
    assert.deepEqual(completed, ["ses_5"])
    assert.deepEqual(store.state("i", "ses_5"), found(goal("active")))
    for (const sessionId of ["ses_1", "ses_2", "ses_3", "ses_4"]) assert.deepEqual(store.state("i", sessionId), { status: "loading" })

    // A running read is aborted as well, and its late answer is never published.
    release!()
    release = store.demand("i", "ses_1")
    await settle()
    assert.deepEqual(dispatched, ["ses_5", "ses_1"])
    release()
    assert.equal(requests.get("ses_1")!.signal.aborted, true)
    requests.get("ses_1")!.answer(found(goal("paused")))
    await settle()
    assert.deepEqual(store.state("i", "ses_1"), { status: "loading" })
  })
})
