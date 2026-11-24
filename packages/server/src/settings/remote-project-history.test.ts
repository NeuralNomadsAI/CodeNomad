import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { parse, stringify } from "yaml"
import { sameServerSelection } from "../codenomad-servers/selection-policy"
import { resolveConfigLocation } from "../config/location"
import { SettingsService } from "./service"
import { readRemoteProjectHistory, RECENT_PROJECT_LIMIT, remoteProjectRecentKey } from "./remote-project-history"

const first = { id: "first", baseUrl: "https://first.example", skipTlsVerify: false }
const second = { id: "second", baseUrl: "https://second.example", skipTlsVerify: true, ssh: { host: "remote" } }
const remoteServers = [first, second].map(policy => ({ ...policy, name: policy.id }))
const local = [{ path: "/local", lastAccessed: 1 }]
const history = (items: Parameters<typeof remoteProjectRecentKey>[0][]) =>
  Object.fromEntries(items.map(item => [remoteProjectRecentKey(item), item]))

function fixture(t: TestContext, ui: object) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".remote-history-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const location = resolveConfigLocation(path.join(root, "config.yaml"))
  fs.writeFileSync(location.stateYamlPath, stringify({ ui, server: { keep: true } }, { aliasDuplicateObjects: false }))
  const logger = { child: () => logger, warn: () => {}, info: () => {} }
  const events: unknown[] = []
  const open = () => new SettingsService(location, { publish: (event: unknown) => events.push(event) } as never, logger as never)
  const disk = () => parse(fs.readFileSync(location.stateYamlPath, "utf8"))
  return { open, disk, events }
}

test("state load and both patch paths bound disk, response and publication while pinning exact active profiles", t => {
  const crowded = Array.from({ length: 30 }, (_, i) => ({ policy: first, path: `/open/${i}`, lastAccessed: 100 + i }))
  const retired = { policy: { ...second, skipTlsVerify: false }, path: "/old-policy", lastAccessed: 1000 }
  const pinned = { policy: second, path: "/pinned", lastAccessed: 1, projectName: "Pinned" }
  const f = fixture(t, { remoteServers, recentFolders: local, remoteProjectRecents: [pinned], remoteProjectHistory: history([...crowded, retired]) })
  const settings = f.open()
  const initial = settings.getOwner("state", "ui")
  assert.equal("remoteProjectRecents" in initial, false)
  const latest = { policy: first, path: "/in-another-window", lastAccessed: 300 }
  const ack = settings.mergePatchOwner("state", "ui", { remoteProjectHistory: history([latest]) })
  const key = remoteProjectRecentKey(latest)
  const renamed = settings.mergePatchDoc("state", { ui: { remoteProjectHistory: { [key]: { projectName: "Renamed" } } } })
  assert.deepEqual((f.events[0] as { value: unknown }).value, ack)
  assert.deepEqual(f.disk(), renamed)
  assert.deepEqual(f.open().getOwner("state", "ui"), renamed.ui)
  const { recents } = readRemoteProjectHistory(undefined, f.disk().ui.remoteProjectHistory)
  assert.equal(recents.length, RECENT_PROJECT_LIMIT + 1)
  assert.deepEqual(recents[0], { ...latest, projectName: "Renamed" })
  assert.deepEqual(recents.at(-1), pinned)
  assert.ok(!recents.some(item => item.path === retired.path))
  assert.deepEqual(f.disk().ui.recentFolders, local)
  assert.deepEqual(f.disk().server, { keep: true })
})

test("load consumes legacy removal markers without bringing back a removed shortcut", t => {
  const removed = { policy: first, path: "/removed", lastAccessed: 10 }
  const marker = { ...removed, removed: true }
  const last = { policy: second, path: "/last", lastAccessed: 42 }
  const f = fixture(t, { remoteServers, remoteProjectRecents: [removed],
    remoteProjectHistory: history([marker, last]) })
  const settings = f.open()
  assert.deepEqual(settings.getOwner("state", "ui"), { remoteServers, remoteProjectHistory: history([last]) })
  settings.mergePatchOwner("state", "server", { another: true })
  assert.deepEqual(f.disk().ui, settings.getOwner("state", "ui"))
  assert.deepEqual(f.open().getOwner("state", "ui"), f.disk().ui)
})

test("a stale rename after removal does not recreate the entry; a fresh open does", t => {
  const row = { policy: first, path: "/one", lastAccessed: 1 }
  const key = remoteProjectRecentKey(row)
  const f = fixture(t, { remoteServers, remoteProjectHistory: history([row]) })
  const settings = f.open()
  const edit = (change: object) => settings.mergePatchOwner("state", "ui", { remoteProjectHistory: { [key]: change } }).remoteProjectHistory
  assert.deepEqual(settings.mergePatchOwner("state", "ui", { remoteProjectHistory: { [key]: null } }).remoteProjectHistory, {})
  const after = readRemoteProjectHistory(undefined, edit({ projectName: "Renamed concurrently" }))
  assert.deepEqual(after.recents, [])
  assert.deepEqual(f.disk().ui.remoteProjectHistory, {})
  assert.deepEqual(readRemoteProjectHistory(undefined, edit({ ...row, lastAccessed: 2, openedName: "Reopened" })).recents,
    [{ ...row, lastAccessed: 2, projectName: "Reopened" }])
})

for (const lateWrite of ["owner", "document"] as const) {
  test(`an older explicit open arriving via the ${lateWrite} patch keeps the latest access and folder`, t => {
    const older = { policy: first, path: "/canonical", lastAccessed: 100 }
    const newer = { ...older, lastAccessed: 300 }
    const other = { policy: first, path: "/another", lastAccessed: 200 }
    const sibling = { ...older, policy: second, lastAccessed: 400 }
    const f = fixture(t, { remoteServers, remoteProjectHistory: history([other, sibling]) })
    const settings = f.open()
    const patchOwner = (remoteProjectHistory: object) => settings.mergePatchOwner("state", "ui", { remoteProjectHistory })
    const patchDoc = (remoteProjectHistory: object) =>
      (settings.mergePatchDoc("state", { ui: { remoteProjectHistory } }).ui as Record<string, unknown>)
    const key = remoteProjectRecentKey(newer)

    // Both opens succeeded; deliver their history writes in reverse order.
    const ack = (lateWrite === "owner" ? patchDoc : patchOwner)(history([newer]))
    assert.deepEqual(readRemoteProjectHistory(undefined, ack.remoteProjectHistory).recents, [sibling, newer, other])
    patchOwner({ [key]: { projectName: "Renamed" } })
    const result = (lateWrite === "owner" ? patchOwner : patchDoc)(history([older]))
    const reloaded = f.open().getOwner("state", "ui")
    assert.deepEqual(result, f.disk().ui)
    assert.deepEqual(result, reloaded)

    const { recents } = readRemoteProjectHistory(undefined, reloaded.remoteProjectHistory)
    assert.deepEqual({
      access: recents.find(item => remoteProjectRecentKey(item) === key)?.lastAccessed,
      // The picker proposes the first row for the selected exact server.
      lastFolder: recents.find(item => sameServerSelection(item.policy, first))?.path,
      rows: recents,
    }, {
      access: 300,
      lastFolder: "/canonical",
      rows: [sibling, { ...newer, projectName: "Renamed" }, other],
    })
  })
}
