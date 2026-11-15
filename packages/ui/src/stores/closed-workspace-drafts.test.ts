import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverEvents } from "../lib/server-events.ts"
import { createTextAttachment } from "../types/attachment.ts"
import { addAttachment, clearAttachments, getAttachments } from "./attachments.ts"
import { hydrateWorkspacePromptState } from "./app-session-prompt-hydration.ts"
import { clearClosedWorkspaceDrafts, MAX_CLOSED_WORKSPACE_DRAFTS } from "./closed-workspace-drafts.ts"
import { addInstance, instances, removeInstance, updateInstance } from "./instances.ts"
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
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  opened.push(id)
  addInstance({ id, folder, port: 0, pid: 0, proxyPath: "", status: "ready", client, ...(temporary ? { temporary } : {}) })
}

/** The server's stop event, removing the instance like any window receives it. */
async function stopped(id: string, reason: "deleted" | "stopped") {
  ;(serverEvents as any).dispatch({ type: "workspace.stopped", workspaceId: id, reason })
  await settle()
  assert.equal(instances().has(id), false)
}

function close(id: string, options?: { authoritative?: boolean; keepDrafts?: boolean }) {
  if (messageStoreBus.getInstance(id)) messageStoreBus.unregisterInstance(id)
  removeInstance(id, options)
  setSessions((previous) => { const next = new Map(previous); next.delete(id); return next })
  sdkManager.destroyClientsForInstance(id)
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

afterEach(() => {
  for (const id of opened.splice(0)) close(id, { keepDrafts: false })
  clearClosedWorkspaceDrafts()
})

describe("closed project drafts", () => {
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

    close("second", { keepDrafts: false })
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
    // No local discard request: another window discarded the shared record.
    open("discarded", "/temporary/one", [], undefined, true)
    setSessionDraftPrompt("discarded", NO_SESSION, "discarded draft")
    await stopped("discarded", "deleted")
    open("restore-owned", "/temporary/two")
    setSessionDraftPrompt("restore-owned", NO_SESSION, "seeded draft")
    close("restore-owned", { authoritative: false, keepDrafts: false })

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
})
