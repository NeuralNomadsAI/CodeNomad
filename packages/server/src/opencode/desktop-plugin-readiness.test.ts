import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { syncBuiltinESMExports } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { ownReadiness, registeredReadiness, READINESS_MAX_PENDING } from "./desktop-plugin-readiness"
import { DesktopPluginLifecycle, type DesktopPluginReadinessTarget } from "./desktop-plugin-lifecycle"
import { followPresence, PRESENCE_READY_SUFFIX } from "./desktop-plugin-presence"
import { installDesktopPluginPresence } from "./desktop-plugin-installation"
import type { ServiceConnection } from "../workspaces/opencode-service"

async function until<T>(read: () => Promise<T | undefined>, timeout = 3_000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(10) }
  throw new Error("Fixture condition timed out")
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-readiness-"))
  const lease = path.join(root, `${randomUUID()}.lease`)
  await fs.writeFile(lease, "")
  const owner = ownReadiness(lease)
  t.after(async () => { await owner.close(); await fs.rm(root, { recursive: true, force: true }) })
  const request = () => until(async () => {
    const names = await fs.readdir(`${lease}.prepare`).catch(() => [])
    const name = names.find(name => name.endsWith(".json"))
    return name ? { file: path.join(`${lease}.prepare`, name), value: JSON.parse(await fs.readFile(path.join(`${lease}.prepare`, name), "utf8")) } : undefined
  })
  return { root, lease, owner, request }
}

test("fresh Location challenges echo the owned lease and change incarnation after same-path reconstruction", async t => {
  const f = await fixture(t)
  const location = path.join(f.root, "project")
  let scope = registeredReadiness(f.root, location, () => {})
  t.after(() => scope.close())
  const prepare = async () => {
    const pending = f.owner.prepare(location, AbortSignal.timeout(2_000), () => {})
    await f.request()
    await scope.reconcile([path.basename(f.lease)])
    return pending
  }
  const first = await prepare()
  assert.equal(first.directory, location)
  assert.equal(first.lease, path.basename(f.lease))
  await scope.close()
  scope = registeredReadiness(f.root, location, () => {})
  const next = await prepare()
  assert.notEqual(first.nonce, next.nonce)
  assert.notEqual(first.incarnation, next.incarnation)
  assert.deepEqual(await fs.readdir(`${f.lease}.prepare`), [])
})

test("foreign nonce, extra fields, expired ACK and disposed incarnation fail closed", async t => {
  const f = await fixture(t)
  const location = path.join(f.root, "project")
  const scope = registeredReadiness(f.root, location, () => {})
  t.after(() => scope.close())
  const controller = new AbortController()
  const pending = f.owner.prepare(location, controller.signal, () => {})
  const refused = assert.rejects(pending, /fixture abort|aborted/)
  const { file, value } = await f.request()
  await scope.reconcile([path.basename(f.lease)])
  const ackFile = file.slice(0, -5) + ".ack"
  const valid = JSON.parse(await fs.readFile(ackFile, "utf8"))
  for (const changed of [{ nonce: randomUUID() }, { extra: true }, { expires: Date.now() - 1 }, { directory: path.join(f.root, "other") }]) {
    await fs.writeFile(ackFile, JSON.stringify({ ...valid, ...changed }))
    await delay(120)
  }
  await scope.close()
  await fs.writeFile(ackFile, JSON.stringify(valid))
  await delay(120)
  assert.equal(value.nonce, valid.nonce)
  controller.abort(new Error("fixture abort"))
  await refused
})

test("lease expiry, pre-admission authority, connection/placement ABA and cancellation fence new IO", async t => {
  const f = await fixture(t)
  const captured = { directory: f.root }
  let placement = captured
  const check = () => { if (placement !== captured) throw new Error("placement replaced") }
  const pending = f.owner.prepare(f.root, AbortSignal.timeout(2_000), check)
  const refused = assert.rejects(pending, /placement replaced/)
  await f.request()
  placement = { directory: path.join(f.root, "other") }
  placement = { directory: f.root }
  assert.equal(placement.directory, captured.directory, "same path after ABA still has a different placement identity")
  await refused
  assert.deepEqual(await fs.readdir(`${f.lease}.prepare`), [])
  assert.throws(() => f.owner.prepare(f.root, AbortSignal.timeout(20), check), /placement replaced/)
  const expired = new Date(Date.now() - 20_000)
  await fs.utimes(f.lease, expired, expired)
  await assert.rejects(f.owner.prepare(f.root, AbortSignal.timeout(100), () => {}), /lease expired/)
})

test("bounded parsing and pending ownership reject overload, malformed and symlink requests", async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const pending = Array.from({ length: READINESS_MAX_PENDING }, () => f.owner.prepare(f.root, controller.signal, () => {}))
  const settled = Promise.allSettled(pending)
  assert.throws(() => f.owner.prepare(f.root, controller.signal, () => {}), /Too many/)
  controller.abort()
  await settled
  await fs.mkdir(`${f.lease}.prepare`, { recursive: true })
  assert.deepEqual(await fs.readdir(`${f.lease}.prepare`), [])
  const scope = registeredReadiness(f.root, f.root, () => {})
  t.after(() => scope.close())
  for (const content of ["{", " ".repeat(8_193), JSON.stringify({ version: 99 })]) {
    const file = path.join(`${f.lease}.prepare`, `${randomUUID()}.json`)
    await fs.writeFile(file, content)
    await scope.reconcile([path.basename(f.lease)])
    assert.equal((await fs.readdir(`${f.lease}.prepare`)).filter(name => name.endsWith(".ack")).length, 0)
    await fs.rm(file)
  }
  const link = path.join(`${f.lease}.prepare`, `${randomUUID()}.json`)
  try { await fs.symlink(f.lease, link) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("Windows symlink privilege unavailable; hard-link admission still exercised"); await fs.link(f.lease, link) }
    else throw error
  }
  await scope.reconcile([path.basename(f.lease)])
  assert.equal((await fs.readdir(`${f.lease}.prepare`)).filter(name => name.endsWith(".ack")).length, 0)
})

test("close drains an admitted ACK write and removes its marker before registration disposal", async t => {
  const f = await fixture(t)
  let current = true
  const scope = registeredReadiness(f.root, f.root, () => { if (!current) throw new Error("scope stopped") })
  const pending = f.owner.prepare(f.root, AbortSignal.timeout(2_000), () => {})
  const refused = assert.rejects(pending)
  await f.request()
  current = false
  await assert.rejects(scope.reconcile([path.basename(f.lease)]), /scope stopped/)
  await scope.close()
  await f.owner.close()
  await refused
  assert.equal((await fs.readdir(f.root)).some(name => /\.scope$|\.prepare$/.test(name)), false)
})

test("targeted lifecycle uses captured connection and exact Location, independently of global ready", { timeout: 12_000 }, async t => {
  const f = await fixture(t)
  const lifecycle = new DesktopPluginLifecycle("session-pruning", async () => Buffer.from("export const desktopPlugin = () => ({})"))
  let activeConnection = true, placement = true, reads = 0
  const seen: string[] = []
  const followers: Array<() => Promise<void>> = []
  const connection = {
    assertCurrent() { if (!activeConnection) throw new Error("connection replaced") },
    client: { plugin: { list: async ({ location }: { location: { directory: string } }) => {
      reads++; seen.push(location.directory)
      if (!followers.length || location.directory !== seen[seen.length - 2]) {
        followers.push(await followPresence(path.join(f.root, "data", "session-pruning", "presence"), async () => () => {}, undefined, undefined, location.directory))
      }
      return { location, data: [{ id: "codenomad-session-pruning", state: { status: "active" } }] }
    } } },
  } as unknown as ServiceConnection
  t.after(async () => { await Promise.all(followers.map(stop => stop())); await lifecycle.stop() })
  const prepared = await lifecycle.prepare({ config: path.join(f.root, "config"), data: path.join(f.root, "data") }, connection.assertCurrent, connection)
  prepared.commit(); await prepared.release()
  const target = (directory: string): DesktopPluginReadinessTarget => ({ connection, location: { directory }, signal: AbortSignal.timeout(5_000), assertCurrent() { if (!placement) throw new Error("placement replaced") } })
  await lifecycle.ready(target(path.join(f.root, "A")))
  await lifecycle.ready()
  await lifecycle.ready(target(path.join(f.root, "B")))
  assert.deepEqual(seen, [path.join(f.root, "A"), path.join(f.root, "B")])
  placement = false
  await assert.rejects(lifecycle.ready(target(f.root)), /placement replaced/)
  placement = true; activeConnection = false
  await assert.rejects(lifecycle.ready(target(f.root)), /connection replaced/)
  assert.equal(reads, 2)
  activeConnection = true
  await assert.rejects(lifecycle.ready({ ...target(f.root), connection: { ...connection } }), /captured connection/)
})

test("plugin active without a current presence follower and false global marker cannot prepare", async t => {
  const f = await fixture(t)
  const lifecycle = new DesktopPluginLifecycle("session-pruning", async () => Buffer.from("export {}"))
  const connection = { assertCurrent() {}, client: { plugin: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: [{ id: "codenomad-session-pruning", state: { status: "active" } }] }) } } } as unknown as ServiceConnection
  t.after(() => lifecycle.stop())
  const prepared = await lifecycle.prepare({ config: path.join(f.root, "config"), data: path.join(f.root, "data") }, () => {}, connection)
  prepared.commit(); await prepared.release()
  await assert.rejects(lifecycle.ready({ connection, location: { directory: f.root }, signal: AbortSignal.timeout(150), assertCurrent() {} }), /abort|timeout/i)
})

test("an old ACK from a still-live same-path scope cannot satisfy the next wait", async t => {
  const f = await fixture(t)
  const scope = registeredReadiness(f.root, f.root, () => {})
  t.after(() => scope.close())
  const first = f.owner.prepare(f.root, AbortSignal.timeout(2_000), () => {})
  await f.request()
  await scope.reconcile([path.basename(f.lease)])
  const old = await first
  const controller = new AbortController()
  const second = f.owner.prepare(f.root, controller.signal, () => {})
  let resolved = false
  void second.then(() => { resolved = true }, () => {})
  const { file } = await f.request()
  await fs.writeFile(file.slice(0, -5) + ".ack", JSON.stringify(old))
  await delay(160)
  controller.abort(new Error("old ACK rejected"))
  await assert.rejects(second, /old ACK rejected|aborted/)
  assert.equal(resolved, false)
})

test("failed real registration publishes neither Location proof nor ACK", async t => {
  const f = await fixture(t)
  await assert.rejects(followPresence(f.root, async () => { throw new Error("registration failed") }, undefined, undefined, f.root), /registration failed/)
  assert.equal((await fs.readdir(f.root)).some(name => name.endsWith(".scope")), false)
})

test("a late admitted ACK write is joined and removed on scope close, with no new writes after invalidation", async t => {
  const f = await fixture(t)
  let current = true, observedInvalid = false, lateAdmissions = 0
  let release!: () => void, admitted!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { admitted = resolve })
  const scope = registeredReadiness(f.root, f.root, () => {
    if (!current) { observedInvalid = true; throw new Error("scope invalid") }
  })
  const controller = new AbortController()
  const pending = f.owner.prepare(f.root, controller.signal, () => { if (!current) throw new Error("caller invalid") })
  const refused = assert.rejects(pending, /invalid|abort/i)
  await f.request()
  const original = fs.writeFile
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (observedInvalid) lateAdmissions++
    if (String(args[0]).endsWith(".ack")) { admitted(); await hold }
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(async () => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); await scope.close() })
  const writing = scope.reconcile([path.basename(f.lease)])
  const failed = assert.rejects(writing, /scope invalid/)
  await entered
  current = false
  controller.abort()
  release()
  await failed
  await scope.close()
  await refused
  assert.equal(lateAdmissions, 0)
  assert.equal((await fs.readdir(f.root)).some(name => name.endsWith(".scope")), false)
  assert.deepEqual(await fs.readdir(`${f.lease}.prepare`), [])
})

test("deadline and captured connection replacement during catalogue wait fence all proof IO", async t => {
  const f = await fixture(t)
  const lifecycle = new DesktopPluginLifecycle("session-pruning", async () => Buffer.from("export {}"))
  let release!: () => void, entered!: () => void, current = true, reads = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const admitted = new Promise<void>(resolve => { entered = resolve })
  const connection = { assertCurrent() { if (!current) throw new Error("connection replaced") }, client: { plugin: { list: async ({ location }: { location: { directory: string } }) => {
    reads++; entered(); await held
    return { location, data: [{ id: "codenomad-session-pruning", state: { status: "active" } }] }
  } } } } as unknown as ServiceConnection
  t.after(() => lifecycle.stop())
  const prepared = await lifecycle.prepare({ config: path.join(f.root, "config"), data: path.join(f.root, "data") }, () => {}, connection)
  prepared.commit(); await prepared.release()
  const target = { connection, location: { directory: f.root }, signal: AbortSignal.timeout(2_000), assertCurrent() {} }
  await assert.rejects(lifecycle.ready({ ...target, deadlineAt: Date.now() - 1 }), /timed out/)
  assert.equal(reads, 0)
  const preparing = lifecycle.ready(target)
  const refused = assert.rejects(preparing, /connection replaced/)
  await admitted
  current = false; release()
  await refused
  const files = await fs.readdir(path.join(f.root, "data", "session-pruning", "presence"))
  assert.equal(files.some(name => name.endsWith(".prepare")), false)
})

test("invalid directories, failed/absent catalogue and the shared remaining deadline fail closed", async t => {
  const f = await fixture(t)
  const lifecycle = new DesktopPluginLifecycle("session-pruning", async () => Buffer.from("export {}"))
  let state: "failed" | "absent" | "active" = "failed", reads = 0
  let abortInList: AbortController | undefined
  const connection = { assertCurrent() {}, client: { plugin: { list: async ({ location }: { location: { directory: string } }) => {
    reads++
    if (abortInList) { abortInList.abort(new Error("aborted during catalogue admission")); throw new Error("late catalogue rejection") }
    return { location, data: state === "absent" ? [] : [{ id: "codenomad-session-pruning", state: { status: state } }] }
  } } } } as unknown as ServiceConnection
  t.after(() => lifecycle.stop())
  const prepared = await lifecycle.prepare({ config: path.join(f.root, "config"), data: path.join(f.root, "data") }, () => {}, connection)
  prepared.commit(); await prepared.release()
  const target = () => ({ connection, location: { directory: f.root }, signal: AbortSignal.timeout(2_000), assertCurrent() {} })
  for (const directory of ["", "relative", "\0", "/" + "é".repeat(2_048)]) {
    await assert.rejects(lifecycle.ready({ ...target(), location: { directory } }), /Invalid readiness Location/)
  }
  assert.equal(reads, 0)
  await assert.rejects(lifecycle.ready(target()), /plugin unavailable/)
  for (state of ["absent", "active"] as const) {
    const start = Date.now()
    await assert.rejects(lifecycle.ready({ ...target(), deadlineAt: start + 180 }), /timed out|abort/i)
    assert(Date.now() - start < 1_000, "catalogue and challenge share the remaining budget")
  }
  abortInList = new AbortController()
  await assert.rejects(lifecycle.ready({ ...target(), signal: abortInList.signal }), /aborted during catalogue/)
})

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-ready-"))
  return { root, paths: { config: path.join(root, "config"), data: path.join(root, "data") } }
}

const leasesOf = (root: string) => path.join(root, "data", "session-pruning", "presence")
const markers = async (directory: string) => (await fs.readdir(directory)).filter(name => name.endsWith(PRESENCE_READY_SUFFIX))

test("the backend is ready once the plugin has registered for its lease, and cleans the marker on stop", async t => {
  const { root, paths } = await temporaryRoot()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const presence = await installDesktopPluginPresence("session-pruning", Buffer.from("bundle"), paths)
  let registered = 0
  const stop = await followPresence(leasesOf(root), async () => { registered++; return () => {} })
  t.after(stop)
  assert.equal(registered, 1)
  assert.equal(await presence.ready, true, "the marker written after registration settles readiness")
  const [marker] = await markers(leasesOf(root))
  assert.match(marker ?? "", /^[\da-f-]+\.lease\.ready$/)
  await presence()
  assert.deepEqual(await markers(leasesOf(root)), [], "stopping the backend removes its marker with its lease")
})

async function waitForMarkers(directory: string, expected: string[]) {
  for (let attempt = 0; attempt < 100 && (await markers(directory)).length < expected.length; attempt++) await delay(10)
  assert.deepEqual(await markers(directory), expected)
}

test("no marker until every follower has registered for the lease", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-ready-followers-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, "abc-123.lease"), "")
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  const slow = followPresence(directory, async () => { await held; return () => {} })
  const ready = await followPresence(directory, async () => () => {})
  t.after(ready)
  await delay(20)
  assert.deepEqual(await markers(directory), [], "a follower still registering withholds the marker")
  finish()
  t.after(async () => (await slow)())
  await slow
  await waitForMarkers(directory, ["abc-123.lease.ready"])
})

test("a follower without presence does not acknowledge, and an older backend's directory is never written", async t => {
  const current = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-ready-current-"))
  const older = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-ready-older-"))
  t.after(() => Promise.all([fs.rm(current, { recursive: true, force: true }), fs.rm(older, { recursive: true, force: true })]))
  await fs.writeFile(path.join(older, "def-456.lease"), "")
  const idle = await followPresence(current, async () => () => {})
  await delay(20)
  assert.deepEqual(await markers(current), [], "a follower without presence acknowledges nothing")
  await idle()
  await fs.writeFile(path.join(current, "abc-123.lease"), "")
  const stop = await followPresence([current, older], async () => () => {})
  t.after(stop)
  await waitForMarkers(current, ["abc-123.lease.ready"])
  assert.deepEqual(await markers(older), [], "read-only legacy leases are never marked")
})

test("readiness never rejects and settles at once when the backend stops before any plugin registers", async t => {
  const { root, paths } = await temporaryRoot()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const presence = await installDesktopPluginPresence("session-pruning", Buffer.from("bundle"), paths)
  const started = Date.now()
  await presence()
  assert.equal(await presence.ready, false)
  assert.ok(Date.now() - started < 1_000, "disposal ends the bounded wait")
})
