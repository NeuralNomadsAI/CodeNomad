import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"
import { getServerMeta } from "../lib/server-meta"
import { compactRemoteProjectHistory, normalizeRemoteProjectRecents, readRemoteProjectHistory, remoteProjectRecentKey, type RemoteProjectRecentData } from "../lib/remote-project-recent-data"
import { applyMergePatch } from "../../../server/src/settings/merge-patch"

const path = "D:\\Same"
const policyA = { id: "profile-a", baseUrl: "https://a.example", skipTlsVerify: false, ssh: { host: "server-a" } }
const policyB = { id: "profile-b", baseUrl: "https://b.example", skipTlsVerify: false }
const profiles = [policyA, policyB].map(policy => ({ ...policy, name: "Build" }))
const initialRecents = [
  { policy: policyA, path, lastAccessed: 3 },
  { policy: policyB, path, lastAccessed: 2 },
]
const local = [{ path, lastAccessed: 1, projectName: "Local" }]
let disk = structuredClone(compactRemoteProjectHistory({ ui: { recentFolders: local, remoteServers: profiles, remoteProjectRecents: initialRecents } }).ui) as {
  recentFolders: typeof local; remoteServers: typeof profiles; remoteProjectHistory: unknown
}
const writes: Record<string, unknown>[] = []
let beforePatch: (() => void) | undefined
serverApi.fetchConfigOwner = async owner => (owner === "ui" ? { settings: { multiBackend: true } } : {}) as never
serverApi.fetchStateOwner = async () => structuredClone(disk) as never
serverApi.patchStateOwner = async (owner, patch) => {
  assert.equal(owner, "ui")
  writes.push(patch as Record<string, unknown>)
  beforePatch?.()
  disk = structuredClone(compactRemoteProjectHistory({ ui: applyMergePatch(disk, patch) }).ui) as typeof disk
  return structuredClone(disk) as never
}
serverApi.fetchServerMeta = async () => ({ serversUsable: true }) as never
serverApi.createWorkspace = async () => { throw new Error("Unexpected local creation") }

const { browsedRemoteRecents, recentProjects, recordRemoteProjectLaunch, removeRecentProject, renameRecentProject, latestRemoteProjectPath } = await import("./recent-projects")
const { findOpenProjectTab, openRemoteProjectForProfile, selectOpenProjectTab, selectRemoteServer } = await import("./remote-project-open")
const { preferencesForBackend, editRemoteProjectRecents, updatePreferences } = await import("./preferences")
const { backendRegistry } = await import("./remote-backends")
const { addInstance, removeInstance, updateInstance } = await import("./instances")
const { attachInstanceTab, activeAppTab, appTabs, activeAppTabId, closeBlankTab, openBlankTab, selectAppTab } = await import("./app-tabs")
const { addRemoteRestoreTab, removeRemoteRestoreTab, remoteRestoreTabs } = await import("./remote-restore-tabs")
const { alertDialogState, dismissAlertDialog } = await import("./alerts")
const { preloadLocaleMessages } = await import("../lib/i18n")
const { serverEvents } = await import("../lib/server-events")
const host = preferencesForBackend("local")
await host.ensureLoaded()
const unsubscribe = host.subscribe()
await getServerMeta()

const remote = (id: string) => recentProjects().find(recent => recent.kind === "remote" && recent.backendId === id)!
const resume = () => (serverEvents as any).dispatch({ type: "storage.stateChanged", owner: "ui", value: structuredClone(disk) })
const idle = () => editRemoteProjectRecents(() => undefined)

test("Browse shows host opens for the selected profile even when the destination has no shortcuts", () => {
  const profile = { ...profiles[0]!, createdAt: "", updatedAt: "" }
  assert.deepEqual(browsedRemoteRecents(profile, []).map(({ backendId, path }) => [backendId, path]), [[policyA.id, path]])
  const merged = browsedRemoteRecents(profile, [{ path: "d:/same/", projectName: "Destination name", lastAccessed: 42 }])
  assert.deepEqual(merged.map(({ path, projectName, lastAccessed }) => [path, projectName, lastAccessed]), [[path, "Destination name", 42]])
  assert.deepEqual(browsedRemoteRecents({ ...profile, skipTlsVerify: true }, []), [])
})

test("bounded metadata excludes credentials, malformed records, and duplicate qualified folders", () => {
  const sample = [
    { ...initialRecents[0], secret: "not metadata" },
    { ...initialRecents[0], path: "d:/same/", lastAccessed: 0 },
    initialRecents[1],
    { ...initialRecents[1], policy: { ...policyB, baseUrl: "https://secret@b.example" } },
    { ...initialRecents[1], path: "/".repeat(4097) },
    ...Array.from({ length: 40 }, (_, i) => ({ ...initialRecents[1], path: `/other/${i}` })),
  ]
  const bounded = normalizeRemoteProjectRecents(sample)
  assert.equal(bounded.length, 17)
  assert.deepEqual(bounded.slice(0, 2), initialRecents)
  assert.deepEqual(bounded.at(-1)?.path, "/other/14")
})

test("host reload metadata stays visible disconnected; only current exact saved targets qualify", async t => {
  const ensure = t.mock.method(backendRegistry, "ensure", async () => { throw new Error("Unexpected probe") })
  assert.deepEqual(recentProjects().map(r => [r.kind, r.backendId, r.path, r.kind === "remote" ? r.serverLabel : r.projectName]), [
    ["remote", policyA.id, path, `Build (${policyA.id})`],
    ["remote", policyB.id, path, `Build (${policyB.id})`],
    ["local", "local", path, "Local"],
  ])
  assert.equal(new Set(recentProjects().map(r => r.key)).size, 3)
  const old = remote(policyA.id)
  assert.equal(old.kind, "remote")
  if (old.kind !== "remote") return
  try {
    for (const changed of [
      { ...profiles[0], baseUrl: "https://new.example" },
      { ...profiles[0], skipTlsVerify: true },
      { ...profiles[0], ssh: { host: "new" } },
      undefined,
    ]) {
      disk.remoteServers = changed ? [changed, profiles[1]] : [profiles[1]]
      resume()
      assert.equal(remote(policyA.id), undefined)
      await assert.rejects(openRemoteProjectForProfile(old.policy, old.path, new AbortController().signal, { projectName: old.projectName }), /selection changed/)
    }
    disk.remoteServers = [{ ...profiles[0], name: "Renamed" }, profiles[1]]
    resume()
    assert.equal(recentProjects().filter(r => r.kind === "remote").find(r => r.backendId === policyA.id)?.serverLabel, "Renamed")
    assert.equal(ensure.mock.callCount(), 0)
    assert.equal(writes.length, 0)
  } finally {
    disk.remoteServers = profiles
    resume()
  }
})

test("remote recents rename, remove, merge canonical aliases, and serialize without mutating local or sibling rows", async () => {
  await renameRecentProject(remote(policyA.id), "Named A")
  await removeRecentProject(remote(policyB.id))
  recordRemoteProjectLaunch(policyB, "/canonical", "/typed")
  recordRemoteProjectLaunch(policyA, "d:/same/", path)
  await idle()
  assert.deepEqual(disk.recentFolders, local)
  assert.ok(writes.every(patch => Object.keys(patch).join() === "remoteProjectHistory"))
  assert.deepEqual(readRemoteProjectHistory(undefined, disk.remoteProjectHistory).recents.map(r => [r.policy.id, r.path, r.projectName]).sort(), [
    [policyA.id, "d:/same/", "Named A"], [policyB.id, "/canonical", undefined],
  ])
})

test("another window's writes between read and patch survive, including reopening the same row", async () => {
  const latest = { policy: policyA, path, lastAccessed: Date.now() + 5000 }
  const sibling = { policy: policyB, path: "/concurrent", lastAccessed: Date.now() + 1000 }
  beforePatch = () => {
    beforePatch = undefined
    disk = applyMergePatch(disk, { remoteProjectHistory: {
      [remoteProjectRecentKey(latest)]: latest,
      [remoteProjectRecentKey(sibling)]: sibling,
    } }) as typeof disk
  }
  await renameRecentProject(remote(policyA.id), "Concurrent name")
  const { recents } = readRemoteProjectHistory(undefined, disk.remoteProjectHistory)
  assert.equal(recents.find(item => item.policy.id === policyA.id)?.lastAccessed, latest.lastAccessed)
  assert.equal(recents.find(item => item.policy.id === policyA.id)?.projectName, "Concurrent name")
  assert.ok(recents.some(item => item.path === sibling.path))
})

test("a removed result stays removed after reload, and an explicit reopen restores it", async () => {
  const entry = remote(policyB.id)
  await removeRecentProject(entry)
  resume()
  assert.ok(!recentProjects().some(row => row.backendId === policyB.id && row.path === entry.path))
  recordRemoteProjectLaunch(policyB, entry.path)
  await idle()
  assert.ok(recentProjects().some(row => row.backendId === policyB.id && row.path === entry.path))
})

test("removal keeps an already-pruned row absent without writing a marker", async () => {
  const saved = disk
  const entry = remote(policyB.id)
  assert.equal(entry.kind, "remote")
  const key = remoteProjectRecentKey(entry)
  try {
    beforePatch = () => {
      beforePatch = undefined
      disk = applyMergePatch(disk, { remoteProjectHistory: { [key]: null } }) as typeof disk
    }
    await removeRecentProject(entry)
    assert.ok(!Object.hasOwn(disk.remoteProjectHistory as object, key))
    assert.ok(!recentProjects().some(row => row.backendId === policyB.id && row.path === entry.path))
  } finally {
    beforePatch = undefined
    disk = saved
    resume()
  }
})

test("an explicit alias open saves the canonical shortcut and removes an older alias for that profile only", async () => {
  const saved = disk
  const rows = [{ path: "/typed-alias", lastAccessed: Date.now() }]
  try {
    recordRemoteProjectLaunch(policyA, rows[0].path, rows[0].path, "Alias name")
    recordRemoteProjectLaunch(policyB, rows[0].path)
    await idle()
    assert.ok(recentProjects().some(row => row.backendId === policyA.id && row.path === rows[0].path))
    recordRemoteProjectLaunch(policyA, "/actual-folder", rows[0].path)
    await idle()
    assert.ok(!recentProjects().some(row => row.backendId === policyA.id && row.path === rows[0].path))
    const canonical = recentProjects().find(row => row.backendId === policyA.id && row.path === "/actual-folder")
    assert.ok(canonical)
    assert.equal(canonical.projectName, "Alias name")
    assert.ok(recentProjects().some(row => row.backendId === policyB.id && row.path === rows[0].path))
    recordRemoteProjectLaunch(policyA, canonical.path, rows[0].path)
    await idle()
    assert.equal(recentProjects().filter(row => row.backendId === policyA.id && [rows[0].path, canonical.path].includes(row.path)).length, 1)
  } finally {
    disk = saved
    resume()
  }
})

test("the display cap never cuts off the last folder of an exact server", () => {
  const saved = disk
  try {
    const now = Date.now() + 60_000
    const history: RemoteProjectRecentData[] = Array.from({ length: 25 }, (_, i) => ({ policy: policyA, path: `/crowded/${i}`, lastAccessed: now + i }))
    history.push({ policy: policyB, path: "/concurrent", lastAccessed: now - 1 })
    disk = { ...disk, remoteProjectHistory: Object.fromEntries(history.map(item => [remoteProjectRecentKey(item), item])) }
    resume()
    assert.equal(recentProjects().length, 20)
    assert.ok(!recentProjects().some(row => row.backendId === policyB.id))
    assert.equal(latestRemoteProjectPath(policyB), "/concurrent")
    assert.equal(latestRemoteProjectPath({ ...policyB, skipTlsVerify: true }), undefined)
  } finally { disk = saved; resume() }
})

test("the Open action joins actual tabs including a waiting tab; the row always opens another occurrence", async t => {
  const ensure = t.mock.method(backendRegistry, "ensure", async (_id: string) => undefined)
  const signal = new AbortController().signal
  const add = (id: string, backendId?: string) => addInstance({ id, backendId, folder: path, port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
  add("local-live")
  add(`${policyA.id}~inventory`, policyA.id)
  add(`${policyB.id}~live`, policyB.id)
  attachInstanceTab("local-live")
  attachInstanceTab(`${policyB.id}~live`)
  openBlankTab()
  const empty = activeAppTab()
  selectRemoteServer(policyA)
  assert.equal(activeAppTab(), empty)
  assert.equal(empty?.kind === "blank" && empty.server?.id, policyA.id)
  selectRemoteServer(policyB)
  const blank = activeAppTab()
  assert.equal(blank, empty)
  assert.equal(blank?.kind === "blank" && blank.server?.id, policyB.id)
  try {
    assert.equal(findOpenProjectTab(path, "local")?.id, "instance:local-live")
    assert.equal(findOpenProjectTab(path, policyA.id), undefined, "inventory-only records do not own tabs")
    attachInstanceTab(`${policyA.id}~inventory`)
    assert.equal(selectOpenProjectTab(policyA, "d:/same/"), true)
    assert.equal(activeAppTabId(), `instance:${policyA.id}~inventory`)
    assert.equal(ensure.mock.callCount(), 0)
    await assert.rejects(openRemoteProjectForProfile(policyA, path, signal), /idle/)
    assert.equal(ensure.mock.callCount(), 1, "Home does not focus the live tab instead of opening")
    addRemoteRestoreTab({
      id: "waiting-a", kind: "remote-restore", retry: async () => { throw new Error("Unexpected recovery") },
      remove: () => removeRemoteRestoreTab("waiting-a"),
      snapshot: { kind: "workspace", backendId: policyA.id, folder: path, occurrence: 1, drafts: { saved: "draft" },
        attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} },
    })
    await assert.rejects(openRemoteProjectForProfile(policyA, path, signal), /idle/)
    assert.equal(ensure.mock.callCount(), 2, "the row does not join a restore placeholder either")
    assert.ok(selectAppTab("waiting-a"))
    assert.equal(selectOpenProjectTab(policyA, path), true)
    assert.equal(activeAppTabId(), "waiting-a")
    assert.equal(remoteRestoreTabs()[0]?.snapshot.drafts.saved, "draft")
    assert.equal(ensure.mock.callCount(), 2, "joining never starts recovery or opens a project")
    assert.ok(appTabs().includes(blank!), "another tab's Browse selection is unchanged")
    await idle()
  } finally {
    if (blank) closeBlankTab(blank.id)
    removeRemoteRestoreTab("waiting-a")
    for (const id of ["local-live", `${policyA.id}~inventory`, `${policyB.id}~live`]) removeInstance(id, { authoritative: false, drafts: "skip" })
  }
})

test("removing a saved server counts and closes only its live and waiting tabs, then forgets its connection and recents", async t => {
  const saved = disk
  disk = { ...saved, remoteProjectHistory: Object.fromEntries(initialRecents.map(item => [remoteProjectRecentKey(item), item])) }
  resume()
  const instanceId = `${policyA.id}~remove`
  const otherId = "local-kept-on-removal"
  const dialog = async () => {
    for (let attempt = 0; attempt < 20 && !alertDialogState(); attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.ok(alertDialogState())
    return alertDialogState()!
  }
  const add = (id: string, backendId?: string) => {
    addInstance({ id, backendId, folder: path, port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
    attachInstanceTab(id)
  }
  add(instanceId, policyA.id)
  add(otherId)
  const removed = t.mock.fn((options?: { retainWorkspace?: boolean }) => {
    assert.equal(options?.retainWorkspace, true)
    removeRemoteRestoreTab("waiting-removal")
  })
  addRemoteRestoreTab({
    id: "waiting-removal", kind: "remote-restore", retry: async () => {}, remove: removed,
    snapshot: { kind: "workspace", backendId: policyA.id, folder: path, occurrence: 1,
      drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} },
  })
  selectAppTab("waiting-removal")
  const forget = t.mock.method(serverApi, "forgetRemoteServer", async (id: string) => {
    assert.equal(id, policyA.id)
    assert.deepEqual(appTabs().map(tab => tab.id), [`instance:${otherId}`])
    assert.equal(host.remoteServers().length, 2)
    return { ok: true as const }
  })
  try {
    await preloadLocaleMessages("en")
    const cancelled = host.removeRemoteServerProfile(policyA.id)
    const confirm = await dialog()
    assert.match(confirm.message, /closing 2 open tabs and removing 1 recent project/)
    dismissAlertDialog()
    confirm.resolve?.(false)
    await cancelled
    assert.equal(appTabs().length, 3)
    assert.equal(forget.mock.callCount(), 0)

    updateInstance(instanceId, { temporary: true })
    const temporaryCancelled = host.removeRemoteServerProfile(policyA.id)
    const cleanup = await dialog()
    dismissAlertDialog()
    cleanup.resolve?.(true)
    const choice = await dialog()
    assert.equal(choice.type, "choice")
    assert.deepEqual(choice.choices?.map(entry => entry.value), ["discard", "keep"])
    dismissAlertDialog()
    choice.resolveChoice?.(null)
    await temporaryCancelled
    assert.equal(appTabs().length, 3)
    assert.equal(forget.mock.callCount(), 0)
    updateInstance(instanceId, { temporary: false })

    const confirmed = host.removeRemoteServerProfile(policyA.id)
    const second = await dialog()
    dismissAlertDialog()
    second.resolve?.(true)
    await confirmed
    assert.equal(forget.mock.callCount(), 1)
    assert.equal(removed.mock.callCount(), 1)
    assert.equal(activeAppTabId(), `instance:${otherId}`)
    assert.deepEqual(host.remoteServers().map(profile => profile.id), [policyB.id])
    assert.deepEqual(host.remoteProjectHistory().recents.map(recent => recent.policy.id), [policyB.id])
  } finally {
    dismissAlertDialog()
    removeRemoteRestoreTab("waiting-removal")
    for (const id of [instanceId, otherId]) removeInstance(id, { authoritative: false, drafts: "skip" })
    disk = saved
    resume()
  }
})

test("server removal impact omits zero counts and uses the locale's plural forms", async () => {
  const { serverRemovalMessage } = await import("./remote-server-removal")
  try {
    await preloadLocaleMessages("en")
    assert.equal(serverRemovalMessage("Build", 0, 0), "Remove Build?")
    assert.equal(serverRemovalMessage("Build", 1, 0), "Remove Build, closing 1 open tab?")
    assert.equal(serverRemovalMessage("Build", 0, 2), "Remove Build, removing 2 recent projects?")
    await preloadLocaleMessages("ru")
    assert.match(serverRemovalMessage("Build", 2, 5), /2 открытые вкладки.*5 недавних проектов/)
  } finally { await preloadLocaleMessages("en") }
})

test("only a live remote tab counts as an opening in Recents", async () => {
  const folder = "/failed-or-live"
  const add = (id: string, status: "ready" | "error", backendId?: string) => {
    addInstance({ id, backendId, folder, port: 0, pid: 0, proxyPath: "", status, client: null })
    attachInstanceTab(id)
  }
  const listed = () => recentProjects().some(row => row.kind === "remote" && row.path === folder)
  try {
    add(`${policyA.id}~failed`, "error", policyA.id)
    add("local-elsewhere", "ready")
    selectAppTab("instance:local-elsewhere")
    assert.equal(selectOpenProjectTab(policyA, folder), true)
    assert.equal(activeAppTabId(), `instance:${policyA.id}~failed`)
    await idle()
    assert.equal(listed(), false, "a failed tab is selectable without counting as an opening")
    add(`${policyA.id}~live`, "ready", policyA.id)
    selectAppTab("instance:local-elsewhere")
    assert.equal(selectOpenProjectTab(policyA, folder), true)
    assert.equal(activeAppTabId(), `instance:${policyA.id}~live`, "a live tab wins over a failed one")
    await idle()
    assert.equal(listed(), true)
  } finally {
    for (const id of [`${policyA.id}~failed`, `${policyA.id}~live`, "local-elsewhere"]) removeInstance(id, { authoritative: false, drafts: "skip" })
  }
})

test("retargeting or aborting during admission revokes that opening", async t => {
  let release = () => {}
  const ensure = t.mock.method(backendRegistry, "ensure", () => new Promise<undefined>(resolve => { release = () => resolve(undefined) }))
  const writesBefore = writes.length
  for (const revoke of ["retarget", "abort"] as const) {
    const controller = new AbortController()
    const pending = openRemoteProjectForProfile(policyA, path, controller.signal)
    if (revoke === "abort") controller.abort()
    else {
      disk.remoteServers = [{ ...profiles[0], skipTlsVerify: true }, profiles[1]]
      resume()
    }
    release()
    assert.equal(await pending, false)
    disk.remoteServers = profiles
    resume()
  }
  assert.equal(ensure.mock.callCount(), 2)
  assert.equal(writes.length, writesBefore)
})

test("flag and host admission hide cached remote rows without discarding them", async () => {
  serverApi.patchConfigOwner = async (_owner, patch) => patch as never
  await updatePreferences({ multiBackend: false })
  assert.ok(recentProjects().every(r => r.kind === "local"))
  await updatePreferences({ multiBackend: true })
  assert.ok(recentProjects().some(r => r.kind === "remote"))
  serverApi.fetchServerMeta = async () => ({ serversUsable: false, localRequest: true }) as never
  await getServerMeta(true)
  assert.ok(recentProjects().every(r => r.kind === "local"))
  unsubscribe()
})
