import assert from "node:assert/strict"
import test from "node:test"
import fs, { mkdtemp, writeFile, unlink, rm } from "node:fs/promises"
import { EventEmitter, once } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { performance } from "node:perf_hooks"
import os from "node:os"
import path from "node:path"
import { setImmediate as flush, setTimeout as delay } from "node:timers/promises"
import { followPresence, PRESENCE_INTERVAL_MS } from "../desktop-plugin-presence"

// Virtual interval ticks exercise the real reconciler without assuming that IO
// finishes within 200 ms. The wall-time bound covers acknowledgements, not sleeps.
for (const delayedIO of [false, true]) test(`close idle, close busy, reopen and settle share one registration${delayedIO ? " with delayed IO" : ""}`, { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mission-presence-"))
  const lease = path.join(directory, "abc.lease")
  let registrations = 0, disposals = 0, work = false
  const observed = new EventEmitter()
  let monotonic = 0
  t.mock.method(performance, "now", () => monotonic)
  t.mock.timers.enable({ apis: ["setInterval"] })
  let blocked: Promise<void> | undefined
  let unblock: (() => void) | undefined
  const originalRead = fs.readdir, originalStat = fs.stat
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === directory && blocked) {
      observed.emit("scan-blocked")
      await blocked
    }
    return originalRead(...args)
  })
  t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
    const result = await originalStat(...args)
    if (args[0] === lease) observed.emit("present")
    return result
  })
  syncBuiltinESMExports()
  t.after(async () => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(directory, { recursive: true, force: true })
  })
  const tick = () => {
    monotonic += PRESENCE_INTERVAL_MS
    t.mock.timers.tick(PRESENCE_INTERVAL_MS)
  }
  const reconcile = async (event: string) => {
    const acknowledgement = once(observed, event)
    tick()
    await acknowledgement
    // Drain the reconciler's promise continuations after the observed callback.
    await flush()
  }
  await writeFile(lease, "")
  const cleanup = await followPresence(directory, async () => {
    registrations++
    observed.emit("registered")
    return () => { disposals++; observed.emit("disposed") }
  }, error => { observed.emit("error", error) }, async () => {
    observed.emit("retention-checked")
    return work
  })
  try {
    assert.equal(registrations, 1)
    await unlink(lease)
    await reconcile("disposed")
    assert.equal(disposals, 1, "idle close unregisters")
    await writeFile(lease, "")
    await reconcile("registered")
    assert.equal(registrations, 2)
    work = true
    await unlink(lease)
    for (let i = 0; i < 2; i++) {
      await reconcile("retention-checked")
      assert.equal(disposals, 1, "busy close retains")
      assert.equal(registrations, 2)
    }
    await writeFile(lease, "")
    await reconcile("present")
    assert.equal(registrations, 2, "reopening retained work does not duplicate setup")
    assert.equal(disposals, 1)
    await unlink(lease)
    work = false
    const settled = once(observed, "disposed")
    if (delayedIO) {
      blocked = new Promise<void>(resolve => { unblock = resolve })
      const entered = once(observed, "scan-blocked")
      tick()
      await entered
      // Reproduce the old interval + 200 ms observation while IO is unfinished.
      monotonic += 200
      t.mock.timers.tick(200)
      await flush()
      assert.equal(disposals, 1, "a pending scan is not a disposal acknowledgement")
      unblock!()
      blocked = undefined
    } else tick()
    await settled
    await flush()
    assert.equal(disposals, 2, "settling after close unregisters")
    assert.equal(registrations, 2)
  } finally {
    unblock?.()
    await cleanup()
  }
})

test("native unload wins over retained work", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mission-presence-"))
  await writeFile(path.join(directory, "abc.lease"), "")
  let disposals = 0
  const cleanup = await followPresence(directory, async () => () => { disposals++ },
    error => { throw error }, async () => true)
  await cleanup()
  assert.equal(disposals, 1)
  await rm(directory, { recursive: true, force: true })
})

test("cleanup waits for in-flight registration and prevents callback resurrection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mission-presence-"))
  const lease = path.join(directory, "abc.lease")
  let setups = 0, disposals = 0
  let release: (() => void) | undefined
  const cleanup = await followPresence(directory, async () => {
    setups++
    await new Promise<void>(resolve => { release = resolve })
    return () => { disposals++ }
  })
  try {
    await writeFile(lease, "")
    for (let i = 0; !release && i < 50; i++) await delay(100)
    assert(release, "poll entered registration")
    let cleaned = false
    const pending = cleanup().then(() => { cleaned = true })
    await delay(20)
    assert.equal(cleaned, false)
    release()
    await pending
    assert.equal(disposals, 1, "late registration is immediately disposed")
    await delay(PRESENCE_INTERVAL_MS + 200)
    assert.equal(setups, 1, "still-live presence cannot resurrect after cleanup")
    assert.equal(disposals, 1)
  } finally {
    release?.()
    await cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})
