import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, readdirSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { OpenCodeClient } from "@opencode/client"
import type { Endpoint } from "@opencode/client/service"
import { OpenCodeSharedService, type OpenCodeSharedServiceDependencies } from "../workspaces/opencode-service"
import { DesktopPluginLifecycle, prepareDesktopPluginPresence } from "./desktop-plugin-lifecycle"
import { installDesktopPluginPresence } from "./desktop-plugin-installation"
import { resolveDesktopPluginPaths } from "./desktop-plugin-paths"

const bundle = Buffer.from("export const desktopPlugin = () => ({ id: 'isolated-fixture' })")
const pathsFor = (root: string) => ({ config: root, data: path.join(root, ".codenomad") })
const leasesFor = (root: string, feature: string) => path.join(root, ".codenomad", feature, "presence")
const entryFor = (root: string, feature: string) => path.join(root, "plugins", `codenomad-${feature}.ts`)
function gate() {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  return { pending, release }
}

test("connection A cannot install after root discovery is superseded by connection B", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-plugin-stale-roots-"))
  const a = path.join(root, "daemon-a"), b = path.join(root, "daemon-b")
  const paused = gate(), resume = gate()
  let reads = 0, automationReads = 0
  const pruning = new DesktopPluginLifecycle("session-pruning", async () => {
    if (++reads === 1) { paused.release(); await resume.pending }
    return bundle
  })
  const automation = new DesktopPluginLifecycle("automation", async () => { automationReads++; return bundle })
  const firstEndpoint: Endpoint = { url: "http://127.0.0.1:4321", auth: { type: "basic", username: "fixture", password: "fixture" } }
  let active = firstEndpoint
  const makeClient: OpenCodeSharedServiceDependencies["makeClient"] = options => ({
    config: { get: async () => [{ type: "directory", path: options.baseUrl === firstEndpoint.url ? a : b }] },
  }) as unknown as OpenCodeClient
  const service = new OpenCodeSharedService({ headers: () => ({ authorization: "Basic fixture" }), makeClient })
  t.after(async () => {
    resume.release()
    await Promise.all([pruning.stop(), automation.stop(), service.shutdown()])
    await rm(root, { recursive: true, force: true })
  })
  const first = service.client({
    kind: "lifecycle", identity: "isolated-roots",
    lifecycle: { discover: async () => active, ensure: async () => active },
    prepareDesktopPlugins: async connection => {
      const paths = await resolveDesktopPluginPaths(connection, { kind: "host", platform: process.platform, binary: "fixture" })
      await prepareDesktopPluginPresence(paths, connection.assertCurrent, { pruning, automation })
      return true
    },
  })
  const rejected = assert.rejects(first, /no longer current|connection changed/)
  await paused.pending
  active = { ...firstEndpoint, url: "http://127.0.0.1:4322" }
  service.invalidate()
  await service.acquire()
  resume.release()
  await rejected
  assert.equal(automationReads, 1, "Only valid connection B may start the second installer")
  const resolvedPaths = await resolveDesktopPluginPaths({ client: { config: { get: async () => [{ type: "directory", path: b }] } }, assertCurrent() {} } as never,
    { kind: "host", platform: process.platform, binary: "fixture" })
  for (const feature of ["session-pruning", "automation"]) {
    await assert.rejects(readFile(entryFor(a, feature)), { code: "ENOENT" })
    await assert.rejects(readdir(leasesFor(a, feature)), { code: "ENOENT" })
    assert.equal((await readdir(path.join(resolvedPaths.data, feature, "presence"))).length, 1)
  }
})

test("stale preparation releases its first lease but preserves another backend's lease", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-plugin-stale-claim-"))
  const paths = pathsFor(root)
  const other = await installDesktopPluginPresence("session-pruning", bundle, paths)
  const paused = gate(), resume = gate()
  let current = true
  const pruning = new DesktopPluginLifecycle("session-pruning", async () => bundle)
  const automation = new DesktopPluginLifecycle("automation", async () => {
    paused.release(); await resume.pending; return bundle
  })
  t.after(async () => {
    resume.release()
    await Promise.all([pruning.stop(), automation.stop()])
    await other()
    await rm(root, { recursive: true, force: true })
  })
  const preparation = prepareDesktopPluginPresence(paths, () => { if (!current) throw new Error("stale connection") }, { pruning, automation })
  const rejected = assert.rejects(preparation, /no longer current|stale connection/)
  await paused.pending
  assert.equal((await readdir(leasesFor(root, "session-pruning"))).length, 2)
  current = false
  resume.release()
  await rejected
  assert.equal((await readdir(leasesFor(root, "session-pruning"))).length, 1)
  await assert.rejects(readFile(entryFor(root, "automation")), { code: "ENOENT" })
})

test("a valid overlapping claim for the same namespace survives the stale attempt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-plugin-concurrent-claim-"))
  const paused = gate(), resume = gate()
  const pruning = new DesktopPluginLifecycle("session-pruning", async () => {
    paused.release(); await resume.pending; return bundle
  })
  const automation = new DesktopPluginLifecycle("automation", async () => bundle)
  t.after(async () => {
    resume.release()
    await Promise.all([pruning.stop(), automation.stop()])
    await rm(root, { recursive: true, force: true })
  })
  let currentA = true
  const first = prepareDesktopPluginPresence(pathsFor(root), () => { if (!currentA) throw new Error("stale A") }, { pruning, automation })
  const rejected = assert.rejects(first, /stale A/)
  await paused.pending
  const second = prepareDesktopPluginPresence(pathsFor(root), () => {}, { pruning, automation })
  currentA = false
  resume.release()
  await Promise.all([rejected, second])
  for (const feature of ["session-pruning", "automation"]) {
    assert.equal((await readdir(leasesFor(root, feature))).length, 1)
  }
})

test("a stale attempt cannot release a previously committed lease of this backend", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-plugin-committed-claim-"))
  const paused = gate(), resume = gate()
  const pruning = new DesktopPluginLifecycle("session-pruning", async () => bundle)
  const automation = new DesktopPluginLifecycle("automation", async () => {
    paused.release(); await resume.pending; return bundle
  })
  t.after(async () => {
    resume.release()
    await Promise.all([pruning.stop(), automation.stop()])
    await rm(root, { recursive: true, force: true })
  })
  await pruning.start(pathsFor(root))
  const originalLeases = await readdir(leasesFor(root, "session-pruning"))
  let current = true
  const pending = prepareDesktopPluginPresence(pathsFor(root), () => { if (!current) throw new Error("stale") }, { pruning, automation })
  const rejected = assert.rejects(pending, /no longer current|stale/)
  await paused.pending
  current = false
  resume.release()
  await rejected
  assert.deepEqual(await readdir(leasesFor(root, "session-pruning")), originalLeases)
  await assert.rejects(readFile(entryFor(root, "automation")), { code: "ENOENT" })
})

test("stopping during pending installation cannot publish or resurrect a lease", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-plugin-stop-pending-"))
  const paused = gate(), resume = gate()
  const lifecycle = new DesktopPluginLifecycle("automation", async () => {
    paused.release(); await resume.pending; return bundle
  })
  t.after(async () => { resume.release(); await lifecycle.stop(); await rm(root, { recursive: true, force: true }) })
  const starting = lifecycle.start(pathsFor(root))
  const rejected = assert.rejects(starting, /has stopped/)
  await paused.pending
  const stopping = lifecycle.stop()
  resume.release()
  await Promise.all([stopping, rejected])
  await assert.rejects(readFile(entryFor(root, "automation")), { code: "ENOENT" })
  await assert.rejects(readdir(leasesFor(root, "automation")), { code: "ENOENT" })
  await assert.rejects(lifecycle.start(pathsFor(root)), /has stopped/)
})

test("installer invalidation after lease creation removes that lease before publication", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-plugin-install-fence-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const leases = leasesFor(root, "automation")
  await assert.rejects(installDesktopPluginPresence("automation", bundle, pathsFor(root), () => {
    if (existsSync(leases) && readdirSync(leases).length) throw new Error("connection superseded")
  }), /connection superseded/)
  assert.deepEqual(await readdir(leases), [])
  await assert.rejects(readFile(entryFor(root, "automation")), { code: "ENOENT" })
})
