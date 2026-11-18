import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { setImmediate as turn } from "node:timers/promises"
import { Effect, Fiber } from "effect"
import { followPresence, PRESENCE_INTERVAL_MS, PRESENCE_READY_SUFFIX } from "./desktop-plugin-presence"

function barrier() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-presence-close-"))
  const gates: ReturnType<typeof barrier>[] = []
  const starts: ReturnType<typeof followPresence>[] = []
  const work: Promise<unknown>[] = []
  const originalWriteFile = fs.writeFile
  let writeReady: typeof fs.writeFile = originalWriteFile
  t.mock.method(fs, "writeFile", (...args: Parameters<typeof fs.writeFile>) =>
    String(args[0]).endsWith(PRESENCE_READY_SUFFIX) ? writeReady(...args) : originalWriteFile(...args))
  syncBuiltinESMExports()
  const gatesFor = () => { const gate = barrier(); gates.push(gate); return gate }
  t.after(async () => {
    // Even a failed assertion must release every barrier and join owned work
    // before restoring filesystem bindings and removing the test directory.
    gates.forEach(gate => gate.release())
    try {
      const settled = await Promise.allSettled(starts)
      await Promise.allSettled(settled.filter(result => result.status === "fulfilled").map(result => result.value()))
      await Promise.allSettled(work)
    } finally {
      t.mock.restoreAll()
      t.mock.timers.reset()
      syncBuiltinESMExports()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
  const start = (...args: Parameters<typeof followPresence>) => {
    const pending = followPresence(...args)
    starts.push(pending)
    return pending
  }
  const lease = async (name = "abc") => {
    const file = path.join(directory, `${name}.lease`)
    await fs.writeFile(file, "")
    return file
  }
  const holdWrites = (fail = false) => {
    const admitted = gatesFor(), unblock = gatesFor(), completed = gatesFor()
    const original = originalWriteFile
    let count = 0
    writeReady = (...args: Parameters<typeof fs.writeFile>) => {
      count++
      const writing = (async () => {
        admitted.release()
        await unblock.wait
        try {
          if (fail) throw new Error("Fixture readiness write failure")
          await original(...args)
        } finally { completed.release() }
      })()
      work.push(writing)
      // Preserve the original rejection for the production retry path.
      void writing.catch(() => {})
      return writing
    }
    return { admitted, unblock, completed, count: () => count }
  }
  let monotonic = 0
  t.mock.method(performance, "now", () => monotonic)
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() })
  const tick = () => { monotonic += PRESENCE_INTERVAL_MS; t.mock.timers.tick(PRESENCE_INTERVAL_MS) }
  return { directory, gatesFor, work, start, lease, holdWrites, tick }
}

test("close drains admitted ready IO before lease-directory removal, including concurrent close", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const lease = await f.lease()
  const writes = f.holdWrites()
  let disposed = 0, closed = false
  const stop = await f.start(f.directory, async () => () => { disposed++ })
  await writes.admitted.wait
  const closing = stop().then(() => { closed = true })
  f.work.push(closing)
  assert.equal(stop(), stop(), "Concurrent callers join the same cleanup")
  await fs.unlink(lease)
  await turn()
  assert.equal(disposed, 1)
  assert.equal(closed, false, "Close must wait for its own already-admitted readiness IO")
  writes.unblock.release()
  await closing
  assert.equal(writes.count(), 1)
  await fs.rm(f.directory, { recursive: true })
  await turn()
  await assert.rejects(fs.stat(`${lease}.ready`), { code: "ENOENT" })
  await stop()
  assert.equal(disposed, 1)
})

test("a blocked writer does not block reconciliation or another follower's close", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const a = await f.lease(), b = await f.lease("def")
  const writes = f.holdWrites()
  let disposed = 0
  const writer = await f.start(f.directory, async () => () => { disposed++ })
  await writes.admitted.wait
  const survivor = await f.start([f.directory, f.directory], async () => () => { disposed++ })
  await survivor()
  assert.equal(disposed, 1, "An unrelated handle must not drain another handle's writes")
  const reconciled = f.gatesFor()
  const observing = await f.start(f.directory, async () => () => { reconciled.release() })
  await Promise.all([fs.unlink(a), fs.unlink(b)])
  f.tick()
  await reconciled.wait
  assert.equal(writes.count(), 2, "Both backend leases are acknowledged independently")
  let closed = false
  const closing = writer().then(() => { closed = true })
  f.work.push(closing)
  await turn()
  assert.equal(closed, false)
  await observing()
  writes.unblock.release()
  await closing
})

test("failed writes remain retryable and failed disposal still drains before rejecting", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await f.lease()
  const writes = f.holdWrites(true)
  let disposed = 0
  const stop = await f.start(f.directory, async () => () => {
    if (++disposed === 1) throw new Error("Fixture disposal failure")
  })
  let settled = false
  const closing = stop().finally(() => { settled = true })
  void closing.catch(() => {})
  f.work.push(closing)
  await turn()
  assert.equal(settled, false, "Failure must still join admitted writes in finally")
  writes.unblock.release()
  await assert.rejects(closing, /Fixture disposal failure/)
  await stop()
  await stop()
  assert.equal(disposed, 2)
  const retryWrites = f.holdWrites()
  const next = await f.start(f.directory, async () => () => {})
  await retryWrites.admitted.wait
  retryWrites.unblock.release()
  await next()
})

test("failed ready writes retry on the next live reconciliation", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const lease = await f.lease()
  const writes = f.holdWrites(true)
  const stop = await f.start(f.directory, async () => () => {})
  writes.unblock.release()
  await writes.completed.wait
  await turn()
  const retry = f.holdWrites()
  f.tick()
  await retry.admitted.wait
  retry.unblock.release()
  await stop()
  assert.equal(await fs.readFile(`${lease}.ready`, "utf8"), "")
})

for (const stage of ["scan", "register", "retain"] as const) {
  test(`stop during ${stage} admits no late readiness writes`, { timeout: 10_000 }, async t => {
    const f = await fixture(t)
    const entered = f.gatesFor(), unblock = f.gatesFor()
    const writes = f.holdWrites()
    let disposed = 0
    let lease: string | undefined
    if (stage === "retain") lease = await f.lease()
    const stop = await f.start(f.directory, async () => {
      if (stage === "register") { entered.release(); await unblock.wait }
      return () => { disposed++ }
    }, error => { throw error }, async () => { entered.release(); await unblock.wait; return true })
    if (stage === "retain") {
      writes.unblock.release()
      await writes.completed.wait
      await fs.unlink(lease!)
    } else await f.lease()
    if (stage === "scan") {
      const original = fs.readdir
      t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
        const result = original(...args)
        if (args[0] === f.directory) { entered.release(); await unblock.wait }
        return result
      })
      syncBuiltinESMExports()
    }
    f.tick()
    await entered.wait
    const count = writes.count()
    const closing = stop()
    f.work.push(closing)
    unblock.release()
    writes.unblock.release()
    await closing
    assert.equal(writes.count(), count, "A stopped follower must not admit IO after an await")
    assert.equal(disposed, stage === "scan" ? 0 : 1)
  })
}

test("interrupting a real Effect scope waits for the follower's admitted write", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await f.lease()
  const writes = f.holdWrites()
  const acquired = f.gatesFor()
  let disposed = 0
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.promise(() => f.start(f.directory, async () => () => { disposed++ })),
      stop => Effect.promise(stop))
    acquired.release()
    yield* Effect.never
  })))
  f.work.push((async () => { await acquired.wait; await Effect.runPromise(Fiber.interrupt(fiber)) })())
  await acquired.wait
  let closed = false
  const closing = Effect.runPromise(Fiber.interrupt(fiber)).then(() => { closed = true })
  f.work.push(closing)
  await turn()
  assert.equal(disposed, 1)
  assert.equal(closed, false)
  writes.unblock.release()
  await closing
  assert.equal(closed, true)
})
