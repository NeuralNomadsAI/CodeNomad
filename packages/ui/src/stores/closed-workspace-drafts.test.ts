import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { serverEvents } from "../lib/server-events.ts"
import { backends, createBackendClient, registerBackendClient } from "../lib/backend-client.ts"
import { parseInstanceKey } from "../lib/backend-identity.ts"
import { backendEvents } from "../lib/backend-events.ts"
import { createTextAttachment } from "../types/attachment.ts"
import { addAttachment, clearAttachments, getAttachments } from "./attachments.ts"
import { hydrateWorkspacePromptState } from "./app-session-prompt-hydration.ts"
import { clearClosedWorkspaceDrafts, MAX_CLOSED_WORKSPACE_DRAFTS } from "./closed-workspace-drafts.ts"
import { addRemoteRestoreTab, remoteRestoreTabs, removeRemoteRestoreTab } from "./remote-restore-tabs.ts"
import { addInstance, instances, removeInstance, updateInstance } from "./instances.ts"
import { closeInstanceTab, selectInstanceTab } from "./app-tabs.ts"
import { preferences } from "./preferences"
import { messageStoreBus } from "./message-v2/bus.ts"
import { clearSessionDraftPrompt, getSessionDraftPrompt, setSessionDraftPrompt, setSessions } from "./session-state.ts"

const NO_SESSION = "__no_session_draft__"
const opened: string[] = []

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function apiSession(id: string, directory: string) {
  return {
    id, title: id, projectID: "project", location: { directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
}

/** Sessions the backend still has; any other id reads as missing. */
function open(id: string, folder: string, existing: string[] = [], read?: (sessionId: string) => Promise<unknown>, temporary = false) {
  const client = { session: { get: ({ sessionID }: { sessionID: string }) =>
    read?.(sessionID) ?? Promise.resolve(existing.includes(sessionID) ? apiSession(sessionID, folder) : null) } } as any
  const { backendId, workspaceId } = parseInstanceKey(id)
  const sdk = backends.get(backendId)?.sdk ?? sdkManager
  ;(sdk as any).clients.set(`${id}:/workspaces/${workspaceId}/instance`, client)
  opened.push(id)
  addInstance({ id, folder, backendId, port: 0, pid: 0, proxyPath: "", status: "ready", client, ...(temporary ? { temporary } : {}) })
}

/** The server's temporary registry broadcast; without one on the connection nothing is a discard. */
const registry = (folders: string[]) =>
  (serverEvents as any).dispatch({ type: "workspace.temporaryChanged", folders })

/** The server's stop event, removing the instance like any window receives it. */
async function stopped(id: string, reason: "deleted" | "stopped") {
  ;(serverEvents as any).dispatch({ type: "workspace.stopped", workspaceId: id, reason })
  await settle()
  assert.equal(instances().has(id), false)
}

function close(id: string, options?: { authoritative?: boolean; drafts?: "keep" | "skip" | "discard" }) {
  if (messageStoreBus.getInstance(id)) messageStoreBus.unregisterInstance(id)
  removeInstance(id, options)
  setSessions((previous) => { const next = new Map(previous); next.delete(id); return next })
  backends.get(parseInstanceKey(id).backendId)?.sdk.destroyClientsForInstance(id)
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

afterEach(() => {
  for (const id of opened.splice(0)) close(id, { drafts: "skip" })
  clearClosedWorkspaceDrafts()
  for (const tab of remoteRestoreTabs()) removeRemoteRestoreTab(tab.id)
})

describe("closed project drafts", () => {
  function remote(t: { after: (run: () => void) => void }, id: string) {
    const client = createBackendClient({ id, baseUrl: `https://${id}.invalid`, relayProfileId: id,
      bindRelayAuthority: true, fetcher: async () => Response.json([]) })
    client.admitRelayAuthority!("d".repeat(43))
    const remove = registerBackendClient(client), detach = backendEvents.attach(id, client.events)
    t.after(() => {
      for (const instance of instances().values()) if (instance.backendId === id) close(instance.id, { drafts: "skip" })
      detach(); remove(); client.events.dispose()
    })
    return client
  }

  it("restores a remote close on the same server only, including attachments and sessions", async t => {
    const a = remote(t, "draft-a")
    remote(t, "draft-b")
    const multiBackend = preferences().multiBackend
    preferences().multiBackend = true
    t.after(() => { preferences().multiBackend = multiBackend })
    open("draft-a~first", "/same", ["shared"])
    setSessionDraftPrompt("draft-a~first", NO_SESSION, "server A [pasted #1]")
    addAttachment("draft-a~first", NO_SESSION, createTextAttachment("A text", "pasted #1 (2 lines)", "paste-1.txt"))
    setSessionDraftPrompt("draft-a~first", "shared", "session A")
    selectInstanceTab("draft-a~first")
    closeInstanceTab("draft-a~first")
    await settle()
    ;(a.events as any).dispatch({ type: "workspace.stopped", workspaceId: "first", reason: "deleted" })
    await settle()
    assert.equal(instances().has("draft-a~first"), false)
    open("draft-b~homonym", "/same", ["shared"])
    open("local-homonym", "/same", ["shared"])
    assert.equal(getSessionDraftPrompt("draft-b~homonym", NO_SESSION), "")
    assert.equal(getSessionDraftPrompt("local-homonym", NO_SESSION), "")
    open("draft-a~again", "/same", ["shared"])
    await settle()
    assert.equal(getSessionDraftPrompt("draft-a~again", NO_SESSION), "server A [pasted #1]")
    assert.equal(getSessionDraftPrompt("draft-a~again", "shared"), "session A")
    assert.equal(getAttachments("draft-a~again", NO_SESSION).length, 1)
  })

  it("vaults a normally closed placeholder's complete prompt state without crossing backend identities", async t => {
    remote(t, "placeholder-a")
    remote(t, "placeholder-b")
    const id = "remote-restore:closed-draft"
    addRemoteRestoreTab({ id, kind: "remote-restore", retry: async () => {}, remove: () => removeRemoteRestoreTab(id),
      snapshot: { kind: "workspace", backendId: "placeholder-a", folder: "/same", occurrence: 2,
        drafts: { [NO_SESSION]: "suspended [pasted #1]", shared: "saved session" },
        attachments: { [NO_SESSION]: [createTextAttachment("suspended text", "pasted #1 (2 lines)", "paste-1.txt")] },
      } as any })
    const closed = remoteRestoreTabs().find(tab => tab.id === id)!
    closed.remove()
    open("placeholder-b~homonym", "/same", ["shared"])
    assert.equal(getSessionDraftPrompt("placeholder-b~homonym", NO_SESSION), "")
    open("placeholder-a~again", "/same", ["shared"])
    await settle()
    assert.equal(getSessionDraftPrompt("placeholder-a~again", NO_SESSION), "suspended [pasted #1]")
    assert.equal(getSessionDraftPrompt("placeholder-a~again", "shared"), "saved session")
    assert.equal(getAttachments("placeholder-a~again", NO_SESSION).length, 1)
    closed.remove()
    open("placeholder-a~later", "/same", ["shared"])
    assert.equal(getSessionDraftPrompt("placeholder-a~later", NO_SESSION), "", "a stale Close cannot restore consumed drafts")
  })

  it("keeps an open placeholder's occurrence state out of sibling openings and retry removal", async t => {
    remote(t, "suspended")
    open("suspended~first", "/same", ["shared"])
    setSessionDraftPrompt("suspended~first", NO_SESSION, "owned by suspended occurrence")
    const id = "remote-restore:reserved"
    addRemoteRestoreTab({ id, kind: "remote-restore", instanceId: "suspended~first",
      retry: async () => {}, remove: () => removeRemoteRestoreTab(id),
      snapshot: { kind: "workspace", backendId: "suspended", folder: "/same", occurrence: 0,
        drafts: { [NO_SESSION]: "owned by suspended occurrence" }, attachments: {} } as any })
    close("suspended~first", { authoritative: false })
    open("suspended~sibling", "/same", ["shared"])
    assert.equal(getSessionDraftPrompt("suspended~sibling", NO_SESSION), "")
    removeRemoteRestoreTab(id) // Successful retry removes the placeholder without closing it.
    open("suspended~later", "/same", ["shared"])
    assert.equal(getSessionDraftPrompt("suspended~later", NO_SESSION), "")
  })

  it("does not let a stale placeholder Close vault drafts or remove its same-ID replacement", async t => {
    remote(t, "replaced-placeholder")
    const id = "remote-restore:replacement"
    const add = (draft: string) => addRemoteRestoreTab({
      id, kind: "remote-restore", retry: async () => {}, remove: () => removeRemoteRestoreTab(id),
      snapshot: { kind: "workspace", backendId: "replaced-placeholder", folder: "/same", occurrence: 0,
        drafts: { [NO_SESSION]: draft }, attachments: {} } as any,
    })
    add("obsolete")
    const obsolete = remoteRestoreTabs().find(tab => tab.id === id)!
    removeRemoteRestoreTab(id)
    add("replacement")
    obsolete.remove()
    assert.equal(remoteRestoreTabs().find(tab => tab.id === id)?.snapshot.drafts[NO_SESSION], "replacement")
    open("replaced-placeholder~before-close", "/same", [])
    assert.equal(getSessionDraftPrompt("replaced-placeholder~before-close", NO_SESSION), "")
    remoteRestoreTabs().find(tab => tab.id === id)!.remove()
    open("replaced-placeholder~after-close", "/same", [])
    assert.equal(getSessionDraftPrompt("replaced-placeholder~after-close", NO_SESSION), "replacement")
  })

  it("lets a remote occurrence's own restored snapshot win over a closed sibling", async t => {
    remote(t, "occurrence-remote")
    open("occurrence-remote~sibling", "/same", ["shared"])
    setSessionDraftPrompt("occurrence-remote~sibling", NO_SESSION, "closed sibling")
    setSessionDraftPrompt("occurrence-remote~sibling", "shared", "closed session")
    close("occurrence-remote~sibling")
    const read = deferred<unknown>()
    open("occurrence-remote~restored", "/same", [], () => read.promise)
    hydrateWorkspacePromptState("occurrence-remote~restored", {
      drafts: { [NO_SESSION]: "own occurrence", shared: "own session" }, attachments: {},
    }, new Set(["shared"]), NO_SESSION)
    read.resolve(apiSession("shared", "/same"))
    await settle()
    assert.equal(getSessionDraftPrompt("occurrence-remote~restored", NO_SESSION), "own occurrence")
    assert.equal(getSessionDraftPrompt("occurrence-remote~restored", "shared"), "own session")
  })

  it("returns unapplied closed drafts when a remote reopening becomes a placeholder", async t => {
    remote(t, "pending-remote")
    open("pending-remote~closed", "/same", ["shared"])
    setSessionDraftPrompt("pending-remote~closed", "shared", "unapplied closed draft")
    close("pending-remote~closed")
    const read = deferred<unknown>()
    open("pending-remote~waiting", "/same", [], () => read.promise)
    const id = "remote-restore:pending-draft"
    addRemoteRestoreTab({ id, kind: "remote-restore", instanceId: "pending-remote~waiting",
      retry: async () => {}, remove: () => removeRemoteRestoreTab(id),
      snapshot: { kind: "workspace", backendId: "pending-remote", folder: "/same", occurrence: 0,
        drafts: {}, attachments: {} } as any })
    close("pending-remote~waiting", { authoritative: false })
    open("pending-remote~sibling", "/same", ["shared"])
    read.resolve(apiSession("shared", "/same"))
    await settle()
    assert.equal(getSessionDraftPrompt("pending-remote~sibling", "shared"), "unapplied closed draft")
    assert.equal(getSessionDraftPrompt("pending-remote~waiting", "shared"), "")
  })

  it("scopes temporary discard authority and reconnect resets to their backend", async t => {
    const a = remote(t, "temporary-a"), b = remote(t, "temporary-b")
    registry(["/temporary/shared"])
    ;(a.events as any).dispatch({ type: "workspace.temporaryChanged", folders: [] })
    // A reconnect of another backend must preserve the local registry's authority.
    for (const handler of (b.events as any).openHandlers) handler()
    open("temporary-local", "/temporary/shared")
    setSessionDraftPrompt("temporary-local", NO_SESSION, "discarded locally")
    await stopped("temporary-local", "deleted")
    open("temporary-a~first", "/temporary/shared")
    setSessionDraftPrompt("temporary-a~first", NO_SESSION, "kept remotely")
    ;(a.events as any).dispatch({ type: "workspace.stopped", workspaceId: "first", reason: "deleted" })
    await settle()
    open("temporary-local-again", "/temporary/shared")
    open("temporary-a~again", "/temporary/shared")
    assert.equal(getSessionDraftPrompt("temporary-local-again", NO_SESSION), "")
    assert.equal(getSessionDraftPrompt("temporary-a~again", NO_SESSION), "kept remotely")
  })

  it("restores drafts and attachments of existing sessions and the new-conversation draft", async () => {
    open("first", "D:\\Work\\App\\", ["kept", "deleted"])
    setSessionDraftPrompt("first", NO_SESSION, "new conversation [pasted #1]")
    addAttachment("first", NO_SESSION, createTextAttachment("pasted text", "pasted #1 (4 lines)", "paste-1.txt"))
    setSessionDraftPrompt("first", "kept", "kept draft")
    setSessionDraftPrompt("first", "deleted", "deleted draft")
    close("first")

    open("second", "d:/work/app", ["kept"])
    assert.equal(getSessionDraftPrompt("second", NO_SESSION), "new conversation [pasted #1]", "applies before sessions load")
    assert.deepEqual(getAttachments("second", NO_SESSION).map(({ display }) => display), ["pasted #1 (4 lines)"])
    await settle()
    assert.equal(getSessionDraftPrompt("second", "kept"), "kept draft")
    assert.equal(getSessionDraftPrompt("second", "deleted"), "", "a session that no longer exists gets nothing")

    close("second", { drafts: "skip" })
    open("third", "D:\\Work\\App", ["kept"])
    await settle()
    assert.equal(getSessionDraftPrompt("third", NO_SESSION), "", "a restored entry is consumed")
  })

  it("never overwrites what the user typed in the reopened tab before hydration", async () => {
    open("typed-first", "/repo", ["kept"])
    setSessionDraftPrompt("typed-first", "kept", "closed draft")
    close("typed-first")

    const read = deferred<unknown>()
    open("typed-second", "/repo", [], () => read.promise)
    setSessionDraftPrompt("typed-second", "kept", "typed again")
    read.resolve(apiSession("kept", "/repo"))
    await settle()
    assert.equal(getSessionDraftPrompt("typed-second", "kept"), "typed again")
  })

  it("keeps nothing for a temporary folder discarded from any window or a restoration-owned instance", async () => {
    // No local discard request: another window discarded the shared record,
    // whose folder the server unregisters only after deleting the record.
    registry(["/temporary/one"])
    open("discarded", "/temporary/one", [], undefined, true)
    setSessionDraftPrompt("discarded", NO_SESSION, "discarded draft")
    await stopped("discarded", "deleted")
    open("restore-owned", "/temporary/two")
    setSessionDraftPrompt("restore-owned", NO_SESSION, "seeded draft")
    close("restore-owned", { authoritative: false, drafts: "skip" })

    open("discarded-again", "/temporary/one")
    open("restore-owned-again", "/temporary/two")
    assert.equal(getSessionDraftPrompt("discarded-again", NO_SESSION), "")
    assert.equal(getSessionDraftPrompt("restore-owned-again", NO_SESSION), "")
  })

  it("keeps drafts of a stopped temporary workspace and of a kept one closed afterwards", async () => {
    open("temporary-stopped", "/temporary/stopped", [], undefined, true)
    setSessionDraftPrompt("temporary-stopped", NO_SESSION, "folder still exists")
    await stopped("temporary-stopped", "stopped")
    open("temporary-kept", "/temporary/kept", [], undefined, true)
    setSessionDraftPrompt("temporary-kept", NO_SESSION, "kept as a project")
    // Keep unregisters the folder before closing; temporaryChanged clears the mark first.
    updateInstance("temporary-kept", { temporary: false })
    await stopped("temporary-kept", "deleted")

    open("temporary-stopped-again", "/temporary/stopped")
    open("temporary-kept-again", "/temporary/kept")
    assert.equal(getSessionDraftPrompt("temporary-stopped-again", NO_SESSION), "folder still exists")
    assert.equal(getSessionDraftPrompt("temporary-kept-again", NO_SESSION), "kept as a project")
  })

  it("lets a later clear or send supersede an older closed occurrence's draft", async () => {
    open("superseded-a", "/superseded", ["cleared", "untouched"])
    open("superseded-b", "/superseded", ["cleared", "untouched"])
    setSessionDraftPrompt("superseded-a", "cleared", "old text")
    addAttachment("superseded-a", "cleared", createTextAttachment("old paste", "pasted #1 (2 lines)", "paste-1.txt"))
    setSessionDraftPrompt("superseded-a", "untouched", "still wanted")
    close("superseded-a")
    setSessionDraftPrompt("superseded-b", "cleared", "sent text")
    clearSessionDraftPrompt("superseded-b", "cleared")
    clearAttachments("superseded-b", "cleared")
    close("superseded-b")

    open("superseded-c", "/superseded", ["cleared", "untouched"])
    await settle()
    assert.equal(getSessionDraftPrompt("superseded-c", "cleared"), "")
    assert.deepEqual(getAttachments("superseded-c", "cleared"), [])
    assert.equal(getSessionDraftPrompt("superseded-c", "untouched"), "still wanted")
  })

  it("gives back only untouched drafts when a restore fails", async () => {
    open("failing-first", "/failing", ["kept"])
    setSessionDraftPrompt("failing-first", NO_SESSION, "cleared while the read failed")
    setSessionDraftPrompt("failing-first", "kept", "kept draft")
    close("failing-first")

    const read = deferred<unknown>()
    open("failing-second", "/failing", [], () => read.promise)
    assert.equal(getSessionDraftPrompt("failing-second", NO_SESSION), "cleared while the read failed")
    clearSessionDraftPrompt("failing-second", NO_SESSION)
    read.reject(new Error("proxy unavailable"))
    await settle()

    open("failing-third", "/failing", ["kept"])
    await settle()
    assert.equal(getSessionDraftPrompt("failing-third", NO_SESSION), "")
    assert.equal(getSessionDraftPrompt("failing-third", "kept"), "kept draft")
  })

  it("never replaces what another restore path hydrated into the reopened instance", async () => {
    open("restored-b", "/restored", ["shared"])
    setSessionDraftPrompt("restored-b", NO_SESSION, "B new conversation")
    setSessionDraftPrompt("restored-b", "shared", "B draft")
    close("restored-b", { authoritative: false })

    const read = deferred<unknown>()
    open("restored-a", "/restored", [], () => read.promise)
    // Occurrence-aware restoration hydrates A's own snapshot after the instance opens.
    hydrateWorkspacePromptState("restored-a", {
      drafts: { [NO_SESSION]: "A new conversation", shared: "A draft" }, attachments: {},
    }, new Set(["shared"]), NO_SESSION)
    read.resolve(apiSession("shared", "/restored"))
    await settle()
    assert.equal(getSessionDraftPrompt("restored-a", NO_SESSION), "A new conversation")
    assert.equal(getSessionDraftPrompt("restored-a", "shared"), "A draft")
  })

  it("keeps drafts of a workspace removed by a backend stop", () => {
    open("stopped", "/stopped")
    setSessionDraftPrompt("stopped", NO_SESSION, "survives a stop")
    close("stopped", { authoritative: false })
    open("restarted", "/stopped")
    assert.equal(getSessionDraftPrompt("restarted", NO_SESSION), "survives a stop")
  })

  it("does not mix folders", () => {
    open("left", "/left")
    setSessionDraftPrompt("left", NO_SESSION, "left draft")
    close("left")
    open("right", "/right")
    assert.equal(getSessionDraftPrompt("right", NO_SESSION), "")
    open("left-again", "/left")
    assert.equal(getSessionDraftPrompt("left-again", NO_SESSION), "left draft")
  })

  it("merges closed occurrences of one folder, the later close winning per session", async () => {
    open("occurrence-a", "/shared", ["a", "both"])
    open("occurrence-b", "/shared", ["a", "both"])
    setSessionDraftPrompt("occurrence-a", "a", "only in a")
    setSessionDraftPrompt("occurrence-a", "both", "older")
    addAttachment("occurrence-a", "both", createTextAttachment("older text", "pasted #1 (2 lines)", "paste-1.txt"))
    setSessionDraftPrompt("occurrence-b", "both", "newer")
    close("occurrence-a")
    close("occurrence-b")

    open("occurrence-c", "/shared", ["a", "both"])
    await settle()
    assert.equal(getSessionDraftPrompt("occurrence-c", "a"), "only in a")
    assert.equal(getSessionDraftPrompt("occurrence-c", "both"), "newer")
    assert.deepEqual(getAttachments("occurrence-c", "both"), [], "a session's text and attachments move together")
  })

  it(`keeps the ${MAX_CLOSED_WORKSPACE_DRAFTS} most recently closed projects`, () => {
    for (let index = 0; index <= MAX_CLOSED_WORKSPACE_DRAFTS; index += 1) {
      open(`bounded-${index}`, `/bounded/${index}`)
      setSessionDraftPrompt(`bounded-${index}`, NO_SESSION, `draft ${index}`)
      close(`bounded-${index}`)
    }
    // A project whose drafts were all sent supersedes nothing and takes no slot.
    open("bounded-sent", "/bounded/sent")
    setSessionDraftPrompt("bounded-sent", NO_SESSION, "sent")
    clearSessionDraftPrompt("bounded-sent", NO_SESSION)
    close("bounded-sent")
    open("bounded-oldest", "/bounded/0")
    open("bounded-next", "/bounded/1")
    open("bounded-newest", `/bounded/${MAX_CLOSED_WORKSPACE_DRAFTS}`)
    assert.equal(getSessionDraftPrompt("bounded-oldest", NO_SESSION), "")
    assert.equal(getSessionDraftPrompt("bounded-next", NO_SESSION), "draft 1")
    assert.equal(getSessionDraftPrompt("bounded-newest", NO_SESSION), `draft ${MAX_CLOSED_WORKSPACE_DRAFTS}`)
  })

  it("gives an unfinished restore back when the reopened tab closes first", async () => {
    open("early-first", "/early", ["kept"])
    setSessionDraftPrompt("early-first", "kept", "not yet restored")
    setSessionDraftPrompt("early-first", NO_SESSION, "cleared after reopening")
    close("early-first")

    const never = deferred<unknown>()
    open("early-second", "/early", [], () => never.promise)
    clearSessionDraftPrompt("early-second", NO_SESSION)
    close("early-second")
    open("early-third", "/early", ["kept"])
    await settle()
    assert.equal(getSessionDraftPrompt("early-third", "kept"), "not yet restored")
    assert.equal(getSessionDraftPrompt("early-third", NO_SESSION), "", "a draft cleared in the reopened tab stays cleared")
  })

  it("keeps a sibling's clear when the last pending restore of the project closes", async () => {
    open("pending-first", "/pending", ["shared"])
    setSessionDraftPrompt("pending-first", "shared", "sent from the sibling")
    close("pending-first")

    const never = deferred<unknown>()
    open("pending-restoring", "/pending", [], () => never.promise)
    open("pending-sibling", "/pending", ["shared"])
    setSessionDraftPrompt("pending-sibling", "shared", "sent from the sibling")
    clearSessionDraftPrompt("pending-sibling", "shared")
    close("pending-sibling")
    close("pending-restoring")

    open("pending-reopened", "/pending", ["shared"])
    await settle()
    assert.equal(getSessionDraftPrompt("pending-reopened", "shared"), "")
  })

  it("lets a clear mark outlive a reopening that completes while an older restore is pending", async () => {
    open("outlive-first", "/outlive", ["sent", "rewritten"])
    setSessionDraftPrompt("outlive-first", "sent", "old text, sent later")
    setSessionDraftPrompt("outlive-first", "rewritten", "old text, rewritten later")
    close("outlive-first")

    const never = deferred<unknown>()
    open("outlive-pending", "/outlive", [], () => never.promise)
    open("outlive-sibling", "/outlive", ["sent", "rewritten"])
    setSessionDraftPrompt("outlive-sibling", "sent", "old text, sent later")
    clearSessionDraftPrompt("outlive-sibling", "sent")
    setSessionDraftPrompt("outlive-sibling", "rewritten", "newer text")
    close("outlive-sibling")
    // This reopening takes the sibling's drafts and finishes before the pending one.
    open("outlive-consumer", "/outlive", ["sent", "rewritten"])
    await settle()
    assert.equal(getSessionDraftPrompt("outlive-consumer", "rewritten"), "newer text")
    close("outlive-pending")

    open("outlive-reopened", "/outlive", ["sent", "rewritten"])
    await settle()
    assert.equal(getSessionDraftPrompt("outlive-reopened", "sent"), "")
    assert.equal(getSessionDraftPrompt("outlive-reopened", "rewritten"), "", "the newer text lives in the open consumer")
  })

  it("never treats a removal as a discard without the current connection's temporary-folder list", async () => {
    const folder = "/temporary/reconnected"
    registry([folder])
    open("reconnected", folder, [], undefined, true)
    setSessionDraftPrompt("reconnected", NO_SESSION, "kept while disconnected")
    // Another window kept the folder while this one was disconnected; the reconnect resets the list.
    const fetchWorkspaces = serverApi.fetchWorkspaces
    serverApi.fetchWorkspaces = async () => { throw new Error("offline") }
    try {
      for (const handler of (serverEvents as any).openHandlers) handler()
      await settle()
    } finally { serverApi.fetchWorkspaces = fetchWorkspaces }
    await stopped("reconnected", "deleted")

    open("reconnected-again", folder)
    assert.equal(getSessionDraftPrompt("reconnected-again", NO_SESSION), "kept while disconnected")
  })

  it("keeps drafts of a kept temporary workspace even when a stale refresh restored its mark", async () => {
    open("stale-kept", "/temporary/stale", [], undefined, true)
    setSessionDraftPrompt("stale-kept", NO_SESSION, "kept despite a stale refresh")
    registry([])
    // A workspace-list response requested before Keep lands after temporaryChanged.
    updateInstance("stale-kept", { temporary: true })
    await stopped("stale-kept", "deleted")

    open("stale-kept-again", "/temporary/stale")
    assert.equal(getSessionDraftPrompt("stale-kept-again", NO_SESSION), "kept despite a stale refresh")
  })

  it("purges every draft and attachment a discarded temporary folder still had in the vault", async () => {
    const folder = "/temporary/purged"
    registry([folder])
    open("purge-first", folder, ["kept"], undefined, true)
    setSessionDraftPrompt("purge-first", "kept", "kept [pasted #1]")
    addAttachment("purge-first", "kept", createTextAttachment("pasted text", "pasted #1 (2 lines)", "paste-1.txt"))
    await stopped("purge-first", "stopped")

    open("purge-second", folder, [], () => Promise.reject(new Error("proxy unavailable")), true)
    await settle()
    await stopped("purge-second", "deleted")

    open("purge-third", folder, ["kept"])
    await settle()
    assert.equal(getSessionDraftPrompt("purge-third", "kept"), "")
    assert.deepEqual(getAttachments("purge-third", "kept"), [])
  })
})
