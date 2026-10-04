import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { performance } from "node:perf_hooks"
import { fileURLToPath, pathToFileURL } from "node:url"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { followPresence, hasPresence, PRESENCE_EXPIRY_MS, PRESENCE_INTERVAL_MS } from "./desktop-plugin-presence"

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-presence-"))
  const lease = path.join(directory, "abc-123.lease")
  await fs.writeFile(lease, "")
  let scans = 0
  const original = fs.readdir
  t.mock.method(fs, "readdir", (...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === directory) scans++
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(async () => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { directory, lease, scans: () => scans }
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await delay(5)
  assert(predicate(), "Expected the asynchronous reconciliation to finish")
}

test("hundreds of native Location followers share one scan but retain independent registrations", async t => {
  const f = await fixture(t)
  let registered = 0, disposed = 0
  const cleanups = await Promise.all(Array.from({ length: 220 }, () => followPresence(f.directory, async () => {
    registered++
    return () => { disposed++ }
  })))
  t.after(() => Promise.all(cleanups.map(cleanup => cleanup())))
  assert.equal(registered, 220)
  assert.equal(f.scans(), 1)
  await cleanups[0]()
  await cleanups[0]()
  assert.equal(disposed, 1, "Cleanup is idempotent and does not affect another Location")
  const another = await followPresence(f.directory, async () => () => { disposed++ })
  assert.equal(f.scans(), 1, "A staggered follower reuses the bounded observation")
  await another()
  await Promise.all(cleanups.map(cleanup => cleanup()))
  assert.equal(disposed, 221)
  const fresh = await followPresence(f.directory, async () => () => {})
  assert.equal(f.scans(), 2, "The final unsubscribe evicts the snapshot")
  await fresh()
})

test("fresh reads remain fresh; shared observations expire and distinguish directories", async t => {
  const f = await fixture(t)
  const now = Date.now()
  let monotonic = 0
  t.mock.method(performance, "now", () => monotonic)
  t.mock.timers.enable({ apis: ["Date"], now })
  const cleanup = await followPresence(f.directory, async () => () => {})
  t.after(cleanup)
  await fs.utimes(f.lease, new Date(now - PRESENCE_EXPIRY_MS - 1000), new Date(now - PRESENCE_EXPIRY_MS - 1000))
  assert.equal(await hasPresence(f.directory), false, "Explicit hasPresence never serves the observation cache")
  let registered = 0
  const cached = await followPresence(f.directory, async () => { registered++; return () => {} })
  assert.equal(registered, 1)
  t.mock.timers.tick(PRESENCE_INTERVAL_MS)
  monotonic += PRESENCE_INTERVAL_MS
  const expired = await followPresence(f.directory, async () => { registered++; return () => {} })
  assert.equal(registered, 1, "A new follower revalidates an expired observation")
  const missing = await followPresence(path.join(f.directory, "missing"), async () => { registered++; return () => {} })
  assert.equal(registered, 1)
  await Promise.all([cached(), expired(), missing()])
})

test("wall-clock rollback cannot extend a shared observation", async t => {
  const f = await fixture(t)
  let monotonic = 0
  t.mock.method(performance, "now", () => monotonic)
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const cleanup = await followPresence(f.directory, async () => () => {})
  await fs.unlink(f.lease)
  t.mock.timers.setTime(Date.now() - 60_000)
  monotonic += PRESENCE_INTERVAL_MS
  let registered = false
  const next = await followPresence(f.directory, async () => { registered = true; return () => {} })
  assert.equal(registered, false)
  assert.equal(f.scans(), 2)
  await Promise.all([cleanup(), next()])
})

test("a failed disposal can be retried without releasing another follower's observation", async t => {
  const f = await fixture(t)
  let disposals = 0
  const cleanup = await followPresence(f.directory, async () => () => {
    if (++disposals === 1) throw new Error("fixture disposal failure")
  })
  const survivor = await followPresence(f.directory, async () => () => {})
  await assert.rejects(cleanup(), /disposal failure/)
  await cleanup()
  await cleanup()
  assert.equal(disposals, 2)
  const another = await followPresence(f.directory, async () => () => {})
  assert.equal(f.scans(), 1, "Retry must not double-release and evict the survivor's reader")
  await Promise.all([survivor(), another()])
})

test("failed setup releases its reader and does not retain an expired active snapshot", async t => {
  const f = await fixture(t)
  await assert.rejects(followPresence(f.directory, async () => { throw new Error("fixture setup failure") }), /setup failure/)
  await fs.unlink(f.lease)
  let registered = false
  const cleanup = await followPresence(f.directory, async () => { registered = true; return () => {} })
  assert.equal(registered, false)
  assert.equal(f.scans(), 2)
  await cleanup()
})

test("independently bundled plugins share scans in the same native process", async t => {
  const f = await fixture(t)
  const source = fileURLToPath(new URL("./desktop-plugin-presence.ts", import.meta.url))
  const outputs = [path.join(f.directory, "one.mjs"), path.join(f.directory, "two.mjs")]
  await Promise.all(outputs.map(outfile => build({ entryPoints: [source], outfile, bundle: true, platform: "node", format: "esm" })))
  const [one, two] = await Promise.all(outputs.map(file => import(pathToFileURL(file).href)))
  const cleanups = await Promise.all([one.followPresence(f.directory, async () => () => {}), two.followPresence(f.directory, async () => () => {})])
  assert.equal(f.scans(), 1)
  await Promise.all(cleanups.map(cleanup => cleanup()))
})

test("a pending scan remains shared past its TTL and is immediately revalidated after completion", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  let monotonic = 0
  t.mock.method(performance, "now", () => monotonic)
  let unblock!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  let hold = true
  const original = fs.readdir
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    const result = original(...args)
    if (args[0] === f.directory && hold) await blocked
    return result
  })
  syncBuiltinESMExports()
  const followers: ReturnType<typeof followPresence>[] = []
  t.after(async () => {
    unblock()
    await Promise.all((await Promise.all(followers)).map(cleanup => cleanup()))
  })
  let registered = 0
  const register = async () => { registered++; return () => {} }
  followers.push(followPresence(f.directory, register))
  assert.equal(f.scans(), 1)
  monotonic += PRESENCE_INTERVAL_MS + 1
  followers.push(followPresence(f.directory, register), followPresence(f.directory, register))
  assert.equal(f.scans(), 1, "Expired but in-flight observations must not start another scan")
  assert.equal(registered, 0)
  hold = false
  unblock()
  await Promise.all(followers)
  assert.equal(registered, 3)
  followers.push(followPresence(f.directory, register))
  await followers[3]
  assert.equal(f.scans(), 2, "Completion must not renew the TTL of a slow scan")
  assert.equal(registered, 4)
})

test("existing followers expire, reactivate and close through their timers with shared scans", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  let monotonic = 0
  t.mock.method(performance, "now", () => monotonic)
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() })
  let registered = 0, disposed = 0
  const cleanups = await Promise.all(Array.from({ length: 3 }, () => followPresence(f.directory, async () => {
    registered++
    return () => { disposed++ }
  })))
  t.after(() => Promise.all(cleanups.map(cleanup => cleanup())))
  assert.equal(registered, 3)
  assert.equal(f.scans(), 1)
  const expired = new Date(Date.now() - PRESENCE_EXPIRY_MS - 1000)
  await fs.utimes(f.lease, expired, expired)
  monotonic += PRESENCE_INTERVAL_MS
  t.mock.timers.tick(PRESENCE_INTERVAL_MS)
  await waitFor(() => disposed === 3)
  assert.equal(f.scans(), 2)
  const refreshed = new Date(Date.now())
  await fs.utimes(f.lease, refreshed, refreshed)
  monotonic += PRESENCE_INTERVAL_MS
  t.mock.timers.tick(PRESENCE_INTERVAL_MS)
  await waitFor(() => registered === 6)
  assert.equal(f.scans(), 3)
  await fs.unlink(f.lease)
  monotonic += PRESENCE_INTERVAL_MS
  t.mock.timers.tick(PRESENCE_INTERVAL_MS)
  await waitFor(() => disposed === 6)
  assert.equal(f.scans(), 4)
  await Promise.all(cleanups.map(cleanup => cleanup()))
  monotonic += PRESENCE_INTERVAL_MS * 3
  t.mock.timers.tick(PRESENCE_INTERVAL_MS * 3)
  await delay(10)
  assert.equal(f.scans(), 4, "Unsubscribed followers must not leave polling timers behind")
  assert.equal(registered, 6)
  assert.equal(disposed, 6)
})

test("teardown waits for pending timer registration and disposes it once without resurrection", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await fs.unlink(f.lease)
  let monotonic = 0
  t.mock.method(performance, "now", () => monotonic)
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() })
  let finish!: () => void
  const registration = new Promise<void>(resolve => { finish = resolve })
  let registered = 0, disposed = 0
  const cleanup = await followPresence(f.directory, async () => {
    registered++
    await registration
    return () => { disposed++ }
  })
  t.after(async () => { finish(); await cleanup() })
  await fs.writeFile(f.lease, "")
  monotonic += PRESENCE_INTERVAL_MS
  t.mock.timers.tick(PRESENCE_INTERVAL_MS)
  await waitFor(() => registered === 1)
  let closed = false
  const closing = cleanup().then(() => { closed = true })
  const repeated = cleanup()
  monotonic += PRESENCE_INTERVAL_MS * 2
  t.mock.timers.tick(PRESENCE_INTERVAL_MS * 2)
  await delay(10)
  assert.equal(closed, false, "Cleanup must wait for registration to supply its disposer")
  assert.equal(disposed, 0)
  finish()
  await Promise.all([closing, repeated])
  assert.equal(disposed, 1)
  monotonic += PRESENCE_INTERVAL_MS * 2
  t.mock.timers.tick(PRESENCE_INTERVAL_MS * 2)
  await delay(10)
  assert.equal(registered, 1)
  assert.equal(disposed, 1)
  assert.equal(f.scans(), 2)
  const fresh = await followPresence(f.directory, async () => () => {})
  t.after(fresh)
  assert.equal(f.scans(), 3, "Teardown must release the pending registration's final reader")
})

test("separate bundles retain overlapping readers and evict only finally unsubscribed directories", { timeout: 10_000 }, async t => {
  const first = await fixture(t)
  const shared = await fixture(t)
  let monotonic = 0
  t.mock.method(performance, "now", () => monotonic)
  const source = fileURLToPath(new URL("./desktop-plugin-presence.ts", import.meta.url))
  const outputs = [path.join(first.directory, "overlap-one.mjs"), path.join(first.directory, "overlap-two.mjs")]
  await Promise.all(outputs.map(outfile => build({ entryPoints: [source], outfile, bundle: true, platform: "node", format: "esm" })))
  const [one, two] = await Promise.all(outputs.map(file => import(pathToFileURL(file).href)))
  const cleanups: Array<() => Promise<void>> = []
  t.after(() => Promise.all(cleanups.map(cleanup => cleanup())))
  let firstDisposed = 0, sharedDisposed = 0
  cleanups.push(await one.followPresence([first.directory, shared.directory, shared.directory], async () => () => { firstDisposed++ }))
  cleanups.push(await two.followPresence(shared.directory, async () => () => { sharedDisposed++ }))
  assert.equal(first.scans(), 1)
  assert.equal(shared.scans(), 1)
  await cleanups[0]()
  await cleanups[0]()
  assert.equal(firstDisposed, 1)
  assert.equal(sharedDisposed, 0, "One bundle's unsubscribe must not dispose the other bundle")
  cleanups.push(await two.followPresence(first.directory, async () => () => {}))
  assert.equal(first.scans(), 2, "A directory with no remaining readers must be evicted immediately")
  cleanups.push(await one.followPresence(shared.directory, async () => () => {}))
  assert.equal(shared.scans(), 1, "The overlapping directory must remain cached across bundles")
  await cleanups[1]()
  await cleanups[3]()
  cleanups.push(await two.followPresence(shared.directory, async () => () => {}))
  assert.equal(shared.scans(), 2, "The final cross-bundle unsubscribe must evict even a deduplicated array reader")
  assert.equal(sharedDisposed, 1)
})
