import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"

// Preferences load when their module is imported, so stub storage first.
const patches: any[] = []
let state: any = { recentFolders: [] }
const calls: string[] = []
serverApi.fetchConfigOwner = async () => ({}) as any
serverApi.fetchStateOwner = async () => state
serverApi.patchStateOwner = async (_owner, patch: any) => { patches.push(patch); state = { ...state, ...patch }; return state }
let discardError: Error | undefined
let createdName: string | undefined
serverApi.keepTemporaryWorkspace = async (id) => { calls.push(`keep:${id}`) }
serverApi.discardTemporaryWorkspace = async (id, options) => {
  // The tab is already closed when the server is asked.
  calls.push(`discard:${id}${options?.onlyWithoutConversations ? ":empty" : ""}:${tabOpen(id) ? "tab" : "closed"}`)
  if (discardError) throw discardError
}
serverApi.createTemporaryFolder = async () => { calls.push("create"); return { path: "D:\\temp\\20261009-120000-dead" } }
serverApi.createWorkspace = async (payload: any) => { createdName = payload?.name; throw new Error("opencode_update_required") }
serverApi.abandonTemporaryFolder = async (path) => { calls.push(`abandon:${path}`) }

const { tGlobal } = await import("../lib/i18n")
const { serverEvents } = await import("../lib/server-events")
const { alertDialogState } = await import("./alerts")
const { appTabs, attachInstanceTab } = await import("./app-tabs")
const { addInstance, instances, removeInstance, updateInstance } = await import("./instances")
const { closeTemporaryInstance, openTemporaryInstance } = await import("./temporary-instances")
const { setSessions } = await import("./session-state")

const folder = "D:\\CodeNomad\\temporary-workspaces\\20261009-120000-abcd"
// Tabs with a conversation ask before closing; empty ones close silently.
function open(...ids: string[]) {
  openEmpty(...ids)
  setSessions((previous) => {
    const next = new Map(previous)
    for (const id of ids) next.set(id, new Map([["ses_1", { id: "ses_1" } as any]]))
    return next
  })
}
function openEmpty(...ids: string[]) {
  for (const id of ids) {
    addInstance({ id, folder, projectName: "Temporary · 12:00", port: 0, pid: 0, proxyPath: "", status: "ready", client: null, temporary: true })
    attachInstanceTab(id)
  }
}
const tabOpen = (id: string) => appTabs().some((tab) => tab.id === `instance:${id}`)
const temporaryChanged = (folders: string[]) => (serverEvents as any).dispatch({ type: "workspace.temporaryChanged", folders })
async function answer(value: string | null) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  const dialog = alertDialogState()
  assert.equal(dialog?.type, "choice")
  assert.deepEqual(dialog?.choices?.map((choice) => choice.value), ["discard", "keep"])
  dialog?.resolveChoice?.(value)
}
function reset(...ids: string[]) {
  for (const id of ids) removeInstance(id, { authoritative: false })
  setSessions((previous) => {
    const next = new Map(previous)
    for (const id of ids) next.delete(id)
    return next
  })
  calls.length = 0
  discardError = undefined
}

test("cancelling the close dialog leaves the temporary tab untouched", async () => {
  open("cancel")
  try {
    const closing = closeTemporaryInstance("cancel")
    await answer(null)
    await closing
    assert.deepEqual(calls, [])
    assert.ok(tabOpen("cancel"))
  } finally { reset("cancel") }
})

test("keeping clears the temporary mark on every tab of the folder and records the named project", async () => {
  open("keep-a", "keep-b")
  try {
    const closing = closeTemporaryInstance("keep-a")
    await answer("keep")
    await closing
    assert.deepEqual(calls, ["keep:keep-a"])
    assert.equal(instances().get("keep-a")?.temporary, false)
    assert.equal(instances().get("keep-b")?.temporary, false)
    assert.equal(tabOpen("keep-a"), false)
    assert.ok(tabOpen("keep-b"))
    assert.deepEqual(patches.at(-1).recentFolders[0], { path: folder, lastAccessed: patches.at(-1).recentFolders[0].lastAccessed, projectName: "Temporary · 12:00" })
  } finally { reset("keep-a", "keep-b") }
})

test("a refused discard shows the localized reason and keeps the tab open", async () => {
  open("busy")
  discardError = new Error("temporary_running")
  try {
    const closing = closeTemporaryInstance("busy")
    await answer("discard")
    await closing
    assert.deepEqual(calls, ["discard:busy:closed"])
    assert.ok(tabOpen("busy"), "a refusal reopens the tab")
    assert.equal(alertDialogState()?.message, tGlobal("temporaryInstance.error.running"))
  } finally { reset("busy") }
})

test("a successful discard closes the tab", async () => {
  open("gone")
  try {
    const closing = closeTemporaryInstance("gone")
    await answer("discard")
    await closing
    assert.deepEqual(calls, ["discard:gone:closed"])
    assert.equal(tabOpen("gone"), false)
  } finally { reset("gone") }
})

test("a temporary tab without conversations closes and is discarded without asking", async () => {
  openEmpty("empty")
  try {
    const before = alertDialogState()
    await closeTemporaryInstance("empty")
    assert.equal(alertDialogState(), before, "nothing is asked")
    assert.deepEqual(calls, ["discard:empty:empty:closed"])
    assert.equal(tabOpen("empty"), false)
  } finally { reset("empty") }
})

test("conversations the tab had not loaded yet bring back the choice", async () => {
  openEmpty("unloaded")
  discardError = new Error("temporary_has_conversations")
  try {
    const closing = closeTemporaryInstance("unloaded")
    await answer(null)
    await closing
    assert.deepEqual(calls, ["discard:unloaded:empty:closed"])
    assert.ok(tabOpen("unloaded"), "nothing was deleted, so the tab is back")
  } finally { reset("unloaded") }
})

test("temporary tabs opened within the same minute get distinct names", async () => {
  openEmpty("same-minute")
  try {
    const name = tGlobal("temporaryInstance.name", {
      time: new Date().toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    })
    updateInstance("same-minute", { projectName: name })
    await assert.rejects(openTemporaryInstance(), /opencode_update_required/)
    assert.equal(createdName, `${name} (2)`)
  } finally { reset("same-minute"); createdName = undefined }
})

test("a keep announced by another window clears the mark", async () => {
  open("elsewhere")
  const other = "D:\\CodeNomad\\temporary-workspaces\\20261008-093000-beef"
  try {
    temporaryChanged([folder, other])
    assert.equal(instances().get("elsewhere")?.temporary, true)
    temporaryChanged([other])
    assert.equal(instances().get("elsewhere")?.temporary, false)
  } finally { reset("elsewhere"); temporaryChanged([]) }
})

test("a mark left stale by a missed event no longer traps the tab", async () => {
  open("stale-keep", "stale-discard")
  try {
    serverApi.keepTemporaryWorkspace = async () => { throw new Error("temporary_not_temporary") }
    const keeping = closeTemporaryInstance("stale-keep")
    await answer("keep")
    await keeping
    assert.equal(tabOpen("stale-keep"), false)
    assert.equal(instances().get("stale-discard")?.temporary, false)

    updateInstance("stale-discard", { temporary: true })
    discardError = new Error("temporary_not_temporary")
    const discarding = closeTemporaryInstance("stale-discard")
    await answer("discard")
    await discarding
    assert.equal(tabOpen("stale-discard"), false)
    assert.equal(alertDialogState()?.message, tGlobal("temporaryInstance.error.notTemporary"))
  } finally {
    serverApi.keepTemporaryWorkspace = async (id) => { calls.push(`keep:${id}`) }
    reset("stale-keep", "stale-discard")
  }
})

test("a failed launch removes the folder it just created", async () => {
  try {
    await assert.rejects(openTemporaryInstance(), /opencode_update_required/)
    assert.deepEqual(calls, ["create", "abandon:D:\\temp\\20261009-120000-dead"])
  } finally { reset() }
})
