import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { installDesktopPluginPresence } from "./desktop-plugin-installation"
import { followPresence, PRESENCE_READY_SUFFIX } from "./desktop-plugin-presence"

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
