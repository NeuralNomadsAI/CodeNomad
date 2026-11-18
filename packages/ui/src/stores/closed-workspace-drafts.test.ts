import assert from "node:assert/strict"
import { after, afterEach, before, describe, it } from "node:test"
import toast from "solid-toast"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { serverEvents } from "../lib/server-events.ts"
import { createFileAttachment, createTextAttachment } from "../types/attachment.ts"
import { addAttachment, clearAttachments, getAttachments } from "./attachments.ts"
import { hydrateWorkspacePromptState } from "./app-session-prompt-hydration.ts"
import { clearClosedWorkspaceDrafts, MAX_CLOSED_WORKSPACE_DRAFTS } from "./closed-workspace-drafts.ts"
import { addInstance, instances, removeInstance, updateInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { clearSessionDraftPrompt, getSessionDraftPrompt, setSessionDraftPrompt, setSessions } from "./session-state.ts"
import { recoveredDraftIds, switchRecoveredDraft } from "./session-draft-recovery.ts"

const NO_SESSION = "__no_session_draft__"
const opened: string[] = []
const originalToast = toast.custom
before(() => { toast.custom = () => "recovered" })
after(() => { toast.custom = originalToast })

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
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  opened.push(id)
  addInstance({ id, folder, port: 0, pid: 0, proxyPath: "", status: "ready", client, ...(temporary ? { temporary } : {}) })
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
  sdkManager.destroyClientsForInstance(id)
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

afterEach(() => {
  for (const id of opened.splice(0)) close(id, { drafts: "skip" })
  clearClosedWorkspaceDrafts()
})

describe("closed project drafts", () => {
  it("keeps an unresolved closed draft and recovers it exactly once across subsequent opens", async () => {
    const folder = "/closed-recovery"
    open("recovery-origin", folder)
    setSessionDraftPrompt("recovery-origin", NO_SESSION, "do not replace")
    setSessionDraftPrompt("recovery-origin", "gone", "draft of removed session")
    addAttachment("recovery-origin", "gone", createFileAttachment("proof.bin", "proof.bin", "application/octet-stream", new Uint8Array([0, 255])))
    close("recovery-origin")

    open("recovery-offline", folder, [], async () => { throw new Error("unavailable") })
    await settle()
    assert.deepEqual(recoveredDraftIds("recovery-offline"), [])
    close("recovery-offline")
    open("recovery-confirmed", folder, [], async sessionID => { throw { _tag: "SessionNotFoundError", sessionID } })
    await settle()
    assert.equal(getSessionDraftPrompt("recovery-confirmed", NO_SESSION), "do not replace")
    assert.equal(recoveredDraftIds("recovery-confirmed").length, 1)
    close("recovery-confirmed")

    open("recovery-reopened", folder, [], async () => assert.fail("local draft slots must not use native reads"))
    await settle()
    const slots = recoveredDraftIds("recovery-reopened")
    assert.equal(slots.length, 1)
    switchRecoveredDraft("recovery-reopened", slots[0])
    assert.equal(getSessionDraftPrompt("recovery-reopened", NO_SESSION), "draft of removed session")
    const [file] = getAttachments("recovery-reopened", NO_SESSION)
    assert.deepEqual(file.source.type === "file" && Array.from(file.source.data ?? []), [0, 255])
    clearSessionDraftPrompt("recovery-reopened", NO_SESSION)
    clearAttachments("recovery-reopened", NO_SESSION)
    close("recovery-reopened")
    open("recovery-after-clear", folder, [], async () => assert.fail("the original must not be replayed"))
    await settle()
    assert.equal(getSessionDraftPrompt("recovery-after-clear", NO_SESSION), "")
    const [draft] = recoveredDraftIds("recovery-after-clear")
    switchRecoveredDraft("recovery-after-clear", draft)
    assert.equal(getSessionDraftPrompt("recovery-after-clear", NO_SESSION), "do not replace")
    assert.deepEqual(recoveredDraftIds("recovery-after-clear"), [])
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
