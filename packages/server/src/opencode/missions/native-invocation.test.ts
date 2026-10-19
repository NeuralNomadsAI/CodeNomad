import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect, Exit } from "effect"
import { nativeInvocation, NATIVE_HUMAN_ANSWER_TIMEOUT_MS } from "./native-invocation"
import { acquireNativeHumanAnswers } from "./native-human-answer"

const origin = Context.Service<never, string>("test/native-invocation/origin")
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("concurrent native invocations use only their own graph, with no stale fallback", async () => {
  const invocation = nativeInvocation(), bothStarted = deferred()
  await assert.rejects(invocation.check(run => run(origin)), /Native Mission invocation unavailable/)
  let started = 0, late!: () => Promise<string>
  const call = (value: string) => Effect.runPromise(invocation.capture(Effect.promise(async () => {
    if (++started === 2) bothStarted.resolve()
    await bothStarted.promise
    // Async callbacks created here retain ALS even after this invocation returns.
    const after = deferred()
    const stale = after.promise.then(() => invocation.check(run => run(origin)))
    void stale.catch(() => {})
    late = () => { after.resolve(); return stale }
    return invocation.check(run => run(origin))
  })).pipe(Effect.provideService(origin, value)))
  assert.deepEqual(await Promise.all([call("a"), call("b")]), ["a", "b"])
  await assert.rejects(invocation.check(run => run(origin)), /Native Mission invocation unavailable/)
  await assert.rejects(late(), /Native Mission invocation unavailable/)
})

test("invocation capture preserves typed failures and defects", async () => {
  const invocation = nativeInvocation(), error = { _tag: "ExactNativeError" }
  assert.deepEqual(await Effect.runPromiseExit(invocation.capture(Effect.fail(error))), Exit.fail(error))
  assert.deepEqual(await Effect.runPromiseExit(invocation.capture(Effect.die(error))), Exit.die(error))
})

test("successive complete checks keep separate deadlines across slow intervening work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const invocation = nativeInvocation()
  await Effect.runPromise(invocation.capture(Effect.tryPromise(async () => {
    for (const expected of [1, 2]) {
      const started = deferred(), release = deferred()
      const result = invocation.check(run => run(Effect.promise(async () => {
        started.resolve(); await release.promise; return expected
      })))
      await started.promise
      t.mock.timers.tick(6_000)
      release.resolve()
      assert.equal(await result, expected)
      // Slow session/authority work between checks consumes no answer budget.
      t.mock.timers.tick(NATIVE_HUMAN_ANSWER_TIMEOUT_MS + 1)
    }
  })))
})

test("one complete check has one deadline across nested reads; timeout does not poison the next check", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const invocation = nativeInvocation(), firstStarted = deferred(), secondStarted = deferred(), release = deferred()
  let aborted = false, settled = false
  await Effect.runPromise(invocation.capture(Effect.tryPromise(async () => {
    const result = invocation.check(async run => {
      await run(Effect.promise(async () => { firstStarted.resolve(); await release.promise }))
      return run(Effect.promise(signal => {
        signal.addEventListener("abort", () => { aborted = true }, { once: true })
        secondStarted.resolve()
        return new Promise<never>(() => {})
      }))
    })
    const refused = assert.rejects(result).then(() => { settled = true })
    await firstStarted.promise
    t.mock.timers.tick(6_000)
    release.resolve()
    await secondStarted.promise
    t.mock.timers.tick(3_999)
    assert.equal(settled, false)
    t.mock.timers.tick(1)
    await refused
    assert.equal(aborted, true)
    assert.equal(await invocation.check(run => run(Effect.succeed("next check"))), "next check")
  })))
})

/** Real answer adapter and invoking runner, with only native services stubbed. */
async function answerRead(t: test.TestContext, read: Effect.Effect<unknown, unknown>, signal?: AbortSignal) {
  const temporary = path.join(tmpdir(), "opencode")
  await mkdir(temporary, { recursive: true })
  const directory = await realpath(await mkdtemp(path.join(temporary, "human-read-")))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, "native.db")
  await writeFile(file, "")
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const database = { db: { $client: Object.assign(() => {}, { unsafe: (sql: string) => ({
    withoutTransform: sql === "PRAGMA database_list" ? Effect.succeed([{ file }]) : read,
  }) }), transaction: () => Effect.void } }
  const graph = Context.make(Context.Service<never, unknown>("@opencode/storage/Database"), database)
    .pipe(Context.add(Context.Service<never, unknown>("@opencode/Location"), location),
      Context.add(Context.Service<never, unknown>("@opencode/Form"), { get() {}, state() {}, reply() {} }))
  const invocation = nativeInvocation()
  const closed = deferred()
  let graphClosed = false
  const result = Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => { graphClosed = true; closed.resolve() }))
    yield* invocation.capture(Effect.tryPromise(() => invocation.check(run => run(Effect.gen(function* () {
      const answers = yield* acquireNativeHumanAnswers({ location } as never, run)
      return yield* Effect.tryPromise(() => answers.binding({ sessionID: "ses_child", formID: "frm_actual", profileID: "profile", executionHost: "host" }))
    })))))
  })).pipe(Effect.provide(graph)), { signal })
  return { result, closed: closed.promise, isClosed: () => graphClosed }
}

test("interruption aborts a real answer read and joins its finalizer before releasing the graph", async t => {
  const started = deferred(), aborted = deferred(), release = deferred()
  let settled = false
  const read = Effect.callback<never>((_resume, signal) => {
    started.resolve()
    signal.addEventListener("abort", aborted.resolve, { once: true })
    return Effect.promise(async () => { await release.promise; settled = true })
  })
  const controller = new AbortController(), f = await answerRead(t, read, controller.signal)
  await started.promise
  controller.abort()
  await aborted.promise
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.isClosed(), false)
  assert.equal(settled, false)
  release.resolve()
  const exit = await f.result
  await f.closed
  assert.equal(Exit.isFailure(exit), true)
  assert.equal(settled, true)
  assert.equal(f.isClosed(), true)
})

test("the answer deadline interrupts and joins a read whose raw Promise ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const started = deferred(), ignored = deferred(), aborted = deferred()
  let promiseSettled = false, continuationRan = false
  const read = Effect.promise(signal => {
    signal.addEventListener("abort", aborted.resolve, { once: true })
    started.resolve()
    return ignored.promise.then(() => { promiseSettled = true; return [] })
  }).pipe(Effect.tap(() => Effect.sync(() => { continuationRan = true })))
  const f = await answerRead(t, read)
  await started.promise
  t.mock.timers.tick(NATIVE_HUMAN_ANSWER_TIMEOUT_MS - 1)
  assert.equal(f.isClosed(), false)
  t.mock.timers.tick(1)
  await aborted.promise
  const exit = await f.result
  assert.equal(Exit.isFailure(exit), true)
  assert.equal(f.isClosed(), true)
  assert.equal(promiseSettled, false)
  ignored.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(promiseSettled, true)
  assert.equal(continuationRan, false, "Cancelled Effect cannot resume into the released graph")
})
