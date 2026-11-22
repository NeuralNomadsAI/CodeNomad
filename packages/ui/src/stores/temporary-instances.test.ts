import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"
import { createBackendClient, registerBackendClient } from "../lib/backend-client"
import { HttpResponseError } from "../lib/retryable-file-search"
import toast from "solid-toast"

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
serverApi.deleteWorkspace = async (id) => { calls.push(`delete:${id}`) }
serverApi.discardTemporaryWorkspace = async (id, options) => {
  // A visible tab has already yielded (or closed, if alone) when the server is asked.
  const tab = !tabOpen(id) ? "closed" : activeAppTabId() === `instance:${id}` ? "active" : "inactive"
  calls.push(`discard:${id}${options?.onlyIfEmpty ? ":empty" : ""}:${tab}`)
  if (discardError) throw discardError
}
serverApi.createTemporaryFolder = async () => { calls.push("create"); return { path: "D:\\temp\\20261009-120000-dead" } }
serverApi.createWorkspace = async payload => { createdName = payload.name; throw new HttpResponseError("opencode_update_required", 426, null) }
serverApi.abandonTemporaryFolder = async (path, requestId?: string) => { calls.push(`abandon:${path}${requestId ? `:${requestId}` : ""}`) }

const { tGlobal } = await import("../lib/i18n")
const { clearToastHistory, getToastHistory } = await import("../lib/notifications")
const { backendEvents, serverEvents } = await import("../lib/server-events")
const { alertDialogState } = await import("./alerts")
const { activeAppTabId, appTabs, attachInstanceTab, selectInstanceTab } = await import("./app-tabs")
const { addInstance, cancelUnattachedWorkspaceCreations, instances, removeInstance, resumeWorkspaceCreations, updateInstance } = await import("./instances")
const { closeTemporaryInstance, keepTemporaryInstance, openTemporaryInstance } = await import("./temporary-instances")
const { clearInstanceDraftPrompts, getSessionDraftPrompt, setSessionDraftPrompt, setSessions } = await import("./session-state")

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
    addInstance({ id, ...(id.startsWith("remote~") ? { backendId: "remote" } : {}),
      folder, projectName: "Temporary · 12:00", port: 0, pid: 0, proxyPath: "", status: "ready", client: null, temporary: true })
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
  for (const id of ids) { removeInstance(id, { authoritative: false, drafts: "skip" }); clearInstanceDraftPrompts(id) }
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
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, ["keep:keep-a", "delete:keep-a"])
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
    assert.deepEqual(calls, ["discard:busy:inactive"])
    assert.ok(tabOpen("busy"))
    assert.equal(alertDialogState()?.message, tGlobal("temporaryInstance.error.running"))
  } finally { reset("busy") }
})

test("a successful discard closes the tab", async () => {
  open("gone")
  try {
    const closing = closeTemporaryInstance("gone")
    await answer("discard")
    await closing
    assert.deepEqual(calls, ["discard:gone:inactive"])
    assert.equal(tabOpen("gone"), false)
  } finally { reset("gone") }
})

test("keep and discard use the owning backend and its raw workspace ID", async () => {
  const requests: string[] = []
  const origin = "https://remote.example"
  const backend = createBackendClient({
    id: "remote", baseUrl: origin,
    fetcher: async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.origin, origin)
      if (url.pathname.startsWith("/api/workspaces/")) requests.push(`${init?.method} ${url.pathname}`)
      return Response.json({})
    },
  })
  const unregister = registerBackendClient(backend)
  const detach = backendEvents.attach(backend.id, backend.events)
  open("remote~keep", "remote~discard")
  try {
    assert.equal(await keepTemporaryInstance("remote~keep"), true)
    const closing = closeTemporaryInstance("remote~discard")
    await answer("discard")
    await closing
    assert.deepEqual(requests, ["POST /api/workspaces/keep/keep", "POST /api/workspaces/discard/discard"])
    assert.deepEqual(calls, [])
    assert.equal(tabOpen("remote~discard"), false)
  } finally { reset("remote~keep", "remote~discard"); detach(); unregister() }
})

for (const code of ["temporary_not_empty", "temporary_running"]) {
  test(`a 409 ${code} refusal does not hide a later foreign close on the restored live record`, async () => {
    const id = `foreign-after-${code}`
    if (code === "temporary_not_empty") openEmpty(id)
    else open(id)
    selectInstanceTab(id)
    const live = instances().get(id)
    const originalToast = toast.custom
    toast.custom = () => "test-toast"
    discardError = new HttpResponseError(code, 409, null, undefined, { error: code })
    try {
      const closing = closeTemporaryInstance(id)
      await answer(code === "temporary_not_empty" ? null : "discard")
      await closing
      assert.equal(instances().get(id), live)
      assert.equal(activeAppTabId(), `instance:${id}`)
      assert.ok(tabOpen(id))
      assert.equal(calls.some(call => call.startsWith("delete:")), false)
      clearToastHistory()
      ;(serverEvents as any).dispatch({ type: "workspace.stopped", workspaceId: id, reason: "deleted" })
      await Promise.resolve()
      assert.equal(tabOpen(id), false)
      assert.equal(getToastHistory().length, 1)
      assert.equal(getToastHistory()[0].message,
        tGlobal("app.closeInstance.toast.otherWindow", { project: "Temporary · 12:00" }))
    } finally { toast.custom = originalToast; clearToastHistory(); reset(id) }
  })
}

test("the visible tab yields to its neighbour before the server stops it, and a refusal restores it in place", async () => {
  openEmpty("neighbour")
  open("visible")
  selectInstanceTab("visible")
  const order = appTabs().map((tab) => tab.id)
  discardError = new Error("temporary_running")
  try {
    const closing = closeTemporaryInstance("visible")
    await answer("discard")
    await closing
    assert.deepEqual(calls, ["discard:visible:inactive"])
    assert.equal(activeAppTabId(), "instance:visible")
    assert.deepEqual(appTabs().map((tab) => tab.id), order)

    calls.length = 0
    discardError = undefined
    const discarding = closeTemporaryInstance("visible")
    await answer("discard")
    await discarding
    assert.deepEqual(calls, ["discard:visible:inactive"])
    assert.equal(activeAppTabId(), "instance:neighbour")
    assert.equal(tabOpen("visible"), false)
  } finally { reset("neighbour", "visible") }
})

test("the last visible tab closes before the server stops it and reopens on refusal", async () => {
  open("alone")
  selectInstanceTab("alone")
  discardError = new Error("temporary_running")
  try {
    const closing = closeTemporaryInstance("alone")
    await answer("discard")
    await closing
    assert.deepEqual(calls, ["discard:alone:closed"])
    assert.equal(activeAppTabId(), "instance:alone")
  } finally { reset("alone") }
})

test("an untouched temporary tab closes and is discarded without asking", async () => {
  openEmpty("empty")
  try {
    const before = alertDialogState()
    await closeTemporaryInstance("empty")
    assert.equal(alertDialogState(), before, "nothing is asked")
    assert.deepEqual(calls, ["discard:empty:empty:inactive"])
    assert.equal(tabOpen("empty"), false)
  } finally { reset("empty") }
})

test("an unsent draft keeps the choice without asking the server first", async () => {
  openEmpty("drafted")
  setSessionDraftPrompt("drafted", "__no_session_draft__", "half-written prompt")
  try {
    const closing = closeTemporaryInstance("drafted")
    await answer(null)
    await closing
    assert.deepEqual(calls, [])
    assert.ok(tabOpen("drafted"))
  } finally { reset("drafted") }
})

test("a discarded folder's drafts are not offered again, even after a refused discard", async () => {
  open("discard-drafted")
  setSessionDraftPrompt("discard-drafted", "__no_session_draft__", "deleted with the folder")
  discardError = new Error("temporary_running")
  try {
    const refused = closeTemporaryInstance("discard-drafted")
    await answer("discard")
    await refused
    discardError = undefined
    const discarding = closeTemporaryInstance("discard-drafted")
    await answer("discard")
    await discarding
    // The server deletes the record before unregistering the folder.
    temporaryChanged([folder])
    ;(serverEvents as any).dispatch({ type: "workspace.stopped", workspaceId: "discard-drafted", reason: "deleted" })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(instances().has("discard-drafted"), false)
    openEmpty("discard-reopened")
    assert.equal(getSessionDraftPrompt("discard-reopened", "__no_session_draft__"), "")
  } finally { reset("discard-drafted", "discard-reopened") }
})

for (const code of ["temporary_has_conversations", "temporary_not_empty", "temporary_open_elsewhere"]) {
  test(`a quiet discard refused with ${code} shows the choice instead of an error`, async () => {
    openEmpty("refused-quietly")
    discardError = new Error(code)
    try {
      const closing = closeTemporaryInstance("refused-quietly")
      await answer(null)
      await closing
      assert.deepEqual(calls, ["discard:refused-quietly:empty:inactive"])
      assert.ok(tabOpen("refused-quietly"), "nothing was deleted, so the tab stays")
    } finally { reset("refused-quietly") }
  })
}

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

for (const supportsCancelAndAbandon of [true, undefined]) test(
  supportsCancelAndAbandon ? "release abandons only the newly allocated folder" : "release only cancels creation on an older server",
  async t => {
  openEmpty("captured")
  const path = "D:\\temp\\20261009-120000-dead"
  t.mock.method(serverApi, "createTemporaryFolder", async () => {
    calls.push("create")
    return { path, supportsCancelAndAbandon }
  })
  let markPosted!: (id: string) => void
  const posted = new Promise<string>(resolve => { markPosted = resolve })
  t.mock.method(serverApi, "createWorkspace", (...[payload, options]: Parameters<typeof serverApi.createWorkspace>) => {
    markPosted(payload.requestId!)
    const signal = options!.signal!
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  })
  t.mock.method(serverApi, "cancelWorkspaceCreation", async (id: string, keepalive: boolean) => { calls.push(`cancel:${id}:${keepalive}`) })
  try {
    const opening = assert.rejects(openTemporaryInstance(), /Window is releasing workspace records/)
    const requestId = await posted
    await cancelUnattachedWorkspaceCreations(new Set(["captured"]))
    await opening
    assert.deepEqual(calls, ["create", supportsCancelAndAbandon ? `abandon:${path}:${requestId}` : `cancel:${requestId}:true`])
    assert.ok(tabOpen("captured"))
  } finally {
    resumeWorkspaceCreations()
    reset("captured")
  }
})
