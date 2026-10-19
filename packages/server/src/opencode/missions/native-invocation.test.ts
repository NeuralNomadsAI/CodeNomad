import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect, Exit } from "effect"
import { nativeInvocation, NATIVE_HUMAN_ANSWER_TIMEOUT_MS as timeout } from "./native-invocation"
import { acquireNativeHumanAnswers } from "./native-human-answer"

const origin = Context.Service<never, string>("test/native-invocation/origin")
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("concurrent graphs are isolated; missing and stale invocations refuse reads", async () => {
  const invocation = nativeInvocation(), both = deferred(), after = deferred()
  await assert.rejects(invocation.check(run => run(origin)), /invocation unavailable/)
  let count = 0, stale!: Promise<string>
  const call = (value: string) => Effect.runPromise(invocation.capture(Effect.promise(async () => {
    if (++count === 2) both.resolve()
    await both.promise
    stale = after.promise.then(() => invocation.check(run => run(origin)))
    void stale.catch(() => {})
    return invocation.check(run => run(origin))
  })).pipe(Effect.provideService(origin, value)))
  assert.deepEqual(await Promise.all([call("a"), call("b")]), ["a", "b"])
  after.resolve()
  await assert.rejects(stale, /invocation unavailable/)
  const error = { _tag: "ExactNativeError" }
  assert.deepEqual(await Effect.runPromiseExit(invocation.capture(Effect.fail(error))), Exit.fail(error))
  assert.deepEqual(await Effect.runPromiseExit(invocation.capture(Effect.die(error))), Exit.die(error))
})

test("interruption joins the real answer read; an abort-ignoring Promise cannot resume in the released graph", async t => {
  const temporary = path.join(tmpdir(), "opencode"); await mkdir(temporary, { recursive: true })
  const directory = await realpath(await mkdtemp(path.join(temporary, "human-read-"))), file = path.join(directory, "native.db")
  t.after(() => rm(directory, { recursive: true, force: true })); await writeFile(file, "")
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const invocation = nativeInvocation(), started = deferred(), release = deferred()
  const controller = new AbortController()
  let closed = false, aborted = false, settled = false, continued = false
  const read = Effect.promise(signal => {
    started.resolve(); signal.addEventListener("abort", () => { aborted = true }, { once: true })
    return release.promise.then(() => { settled = true; return [{ id: "ses_child", project_id: "project", directory, workspace_id: null }] })
  }).pipe(Effect.tap(() => Effect.sync(() => { continued = true })), Effect.ensuring(Effect.promise(() => release.promise)))
  const database = { db: { $client: Object.assign(() => {}, { unsafe: (sql: string) => ({
    withoutTransform: sql === "PRAGMA database_list" ? Effect.succeed([{ file }]) : read,
  }) }), transaction: () => Effect.void } }
  const graph = Context.make(Context.Service<never, unknown>("@opencode/storage/Database"), database)
    .pipe(Context.add(Context.Service<never, unknown>("@opencode/Location"), location),
      Context.add(Context.Service<never, unknown>("@opencode/Form"), { get() {}, state() {}, reply() {} }))
  const result = Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => { closed = true }))
    yield* invocation.capture(Effect.tryPromise(() => invocation.check(run => run(Effect.gen(function* () {
      const answers = yield* acquireNativeHumanAnswers({ location } as never, run)
      return yield* Effect.tryPromise(() => answers.binding({ sessionID: "ses_child", formID: "frm_actual", profileID: "profile", executionHost: "host" }))
    })))))
  })).pipe(Effect.provide(graph)), { signal: controller.signal })
  await started.promise; controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  const before = { closed, settled, aborted }; release.resolve()
  assert(Exit.isFailure(await result)); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual({ before, closed, settled, continued }, { before: { closed: false, settled: false, aborted: true }, closed: true, settled: true, continued: false })
})

test("each check owns one deadline across reads, independent of slow work or an expired check", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const invocation = nativeInvocation(), first = deferred(), second = deferred(), release = deferred()
  await Effect.runPromise(invocation.capture(Effect.tryPromise(async () => {
    assert.equal(await invocation.check(run => run(Effect.succeed("before slow work"))), "before slow work")
    t.mock.timers.tick(timeout + 1)
    assert.equal(await invocation.check(run => run(Effect.succeed("after slow work"))), "after slow work")
    const result = invocation.check(async run => {
      await run(Effect.promise(async () => { first.resolve(); await release.promise }))
      return run(Effect.promise(signal => {
        second.resolve()
        return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
      }))
    })
    let settled = false
    const refused = assert.rejects(result).then(() => { settled = true })
    await first.promise; t.mock.timers.tick(6_000); release.resolve(); await second.promise
    t.mock.timers.tick(timeout - 6_001)
    assert.equal(settled, false); t.mock.timers.tick(1)
    await refused
    assert.equal(await invocation.check(run => run(Effect.succeed("after timeout"))), "after timeout")
  })))
})
