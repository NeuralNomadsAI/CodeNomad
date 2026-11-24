import assert from "node:assert/strict"
import { after, afterEach, before, describe, it } from "node:test"
import toast from "solid-toast"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { serverEvents } from "../lib/server-events.ts"
import { backends, createBackendClient, registerBackendClient } from "../lib/backend-client.ts"
import { LOCAL_BACKEND_ID, parseInstanceKey } from "../lib/backend-identity.ts"
import { backendEvents } from "../lib/backend-events.ts"
import { addRemoteRestoreTab, remoteRestoreTabs, removeRemoteRestoreTab } from "./remote-restore-tabs.ts"
import { createFileAttachment, createTextAttachment } from "../types/attachment.ts"
import { addAttachment, clearAttachments, getAttachments } from "./attachments.ts"
import { hydrateWorkspacePromptState } from "./app-session-prompt-hydration.ts"
import { clearClosedWorkspaceDrafts, MAX_CLOSED_WORKSPACE_DRAFTS, restoreClosedWorkspaceDrafts } from "./closed-workspace-drafts.ts"
import { addInstance, instances, removeInstance, updateInstance } from "./instances.ts"
import { closeInstanceTab, selectInstanceTab } from "./app-tabs.ts"
import { preferences } from "./preferences"
import { messageStoreBus } from "./message-v2/bus.ts"
import { clearSessionDraftPrompt, getSessionDraftPrompt, setSessionDraftPrompt, setSessions } from "./session-state.ts"
import { recoveredDraftIds, switchRecoveredDraft } from "./session-draft-recovery.ts"
import { hydrateRestoredWorkspaceState } from "./app-session-workspace-hydration"
import { serializeDraftAttachments } from "./client-state-attachments-codec"
import { captureState } from "../lib/hooks/use-app-session-capture"
import { createRestorableSessionPreservation, mergeRestorableSessionState, recordRestoredTab } from "./app-session-snapshot-merge"
import { getInstanceAppTabId } from "./app-tabs"
import { attachInstanceTab } from "./app-tabs"
import { encodeClientSnapshotV2, decodeClientSnapshotV2 } from "./client-state-partitions"

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
function open(id: string, folder: string, existing: string[] = [], read?: (sessionId: string) => Promise<unknown>,
  temporary = false, restoringSnapshot = false) {
  const client = { session: { get: ({ sessionID }: { sessionID: string }) =>
    read?.(sessionID) ?? Promise.resolve(existing.includes(sessionID) ? apiSession(sessionID, folder) : null) } } as any
  const { backendId, workspaceId } = parseInstanceKey(id)
  const sdk = backends.get(backendId)?.sdk ?? sdkManager
  ;(sdk as any).clients.set(`${id}:/workspaces/${workspaceId}/instance`, client)
  opened.push(id)
  addInstance({ id, folder, ...(backendId !== LOCAL_BACKEND_ID ? { backendId } : {}),
    port: 0, pid: 0, proxyPath: "", status: "ready", client, ...(temporary ? { temporary } : {}) })
  if (!restoringSnapshot) attachInstanceTab(id)
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

  for (const simple of [true, false]) it(`carries edited drafts across successive reopenings (${simple ? "folder" : "saved ID"})`, async () => {
    const key = `draft-successor-${simple}`, folder = `/${key}`, original = `${key}-original`, successor = `${key}-successor`
    const file = (byte: number) => createFileAttachment("successor.bin", "successor.bin", "application/octet-stream", new Uint8Array([byte]))
    const snapshot = (workspaceId: string, text: string, byte: number) => ({
      kind: "workspace" as const, folder, workspaceId, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      ...serializeDraftAttachments({ shared: text }, { shared: [file(byte)] }),
    })
    const edit = (id: string, text: string, byte: number) => {
      setSessionDraftPrompt(id, "shared", text)
      clearAttachments(id, "shared")
      addAttachment(id, "shared", file(byte))
    }
    const check = (id: string, text: string, bytes: number[][]) => {
      assert.equal(getSessionDraftPrompt(id, "shared"), text)
      assert.deepEqual(getAttachments(id, "shared").map(({ source }) =>
        source.type === "file" && Array.from(source.data ?? [])), bytes)
    }
    open(original, folder)
    edit(original, "first version", 65)
    close(original)
    open(successor, folder, ["shared"], undefined, false, true)
    await hydrateRestoredWorkspaceState(successor, snapshot(original, "old snapshot", 1), new AbortController().signal, () => true)
    await settle()
    check(successor, "first version", [[65]])
    const sibling = `${key}-independent`
    open(sibling, folder, ["shared"], undefined, false, true)
    await hydrateRestoredWorkspaceState(sibling, snapshot(sibling, "independent B", 66), new AbortController().signal, () => true)
    edit(successor, "edited successor", 90)
    close(successor)

    const second = `${key}-second`
    open(second, folder, ["shared"], undefined, false, !simple)
    if (!simple) await hydrateRestoredWorkspaceState(second, snapshot(successor, "first version", 65), new AbortController().signal, () => true)
    await settle()
    check(second, "edited successor", [[90]])
    check(sibling, "independent B", [[66]])
    edit(second, "next edit", 91)
    close(second)
    const third = `${key}-third`
    open(third, folder, ["shared"], undefined, false, true)
    await hydrateRestoredWorkspaceState(third, snapshot(second, "edited successor", 90), new AbortController().signal, () => true)
    await settle()
    check(third, "next edit", [[91]])
    const old = `${key}-old-source`
    open(old, folder, ["shared"], undefined, false, true)
    await hydrateRestoredWorkspaceState(old, snapshot(original, "old snapshot", 1), new AbortController().signal, () => true)
    await settle()
    check(old, "", [])
    clearSessionDraftPrompt(third, "shared")
    clearAttachments(third, "shared")
    close(third)
    const fourth = `${key}-fourth`
    open(fourth, folder, ["shared"], undefined, false, true)
    await hydrateRestoredWorkspaceState(fourth, snapshot(third, "next edit", 91), new AbortController().signal, () => true)
    await settle()
    check(fourth, "", [])
    check(sibling, "independent B", [[66]])
  })

  for (const outcome of ["completed", "interrupted", "failed"] as const) for (const first of ["A", "B"] as const) {
    it(`keeps both recent drafts after an exact restore is ${outcome} (${first} first)`, async () => {
      const key = `returned-${outcome}-${first}`, folder = `/${key}`, original = `${key}-original`, pending = `${key}-pending`, sibling = `${key}-sibling`
      const snapshot = (workspaceId: string, text: string, byte: number) => ({
        kind: "workspace" as const, folder, workspaceId, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
        ...serializeDraftAttachments({ shared: text }, { shared: [
          createFileAttachment("draft.bin", "draft.bin", "application/octet-stream", new Uint8Array([byte])),
        ] }),
      })
      const saved = { A: snapshot(original, "stale A", 1), B: snapshot(sibling, "stale B", 2) }
      const edit = (id: string, text: string, byte: number) => {
        setSessionDraftPrompt(id, "shared", text)
        addAttachment(id, "shared", createFileAttachment("draft.bin", "draft.bin", "application/octet-stream", new Uint8Array([byte])))
      }
      open(original, folder)
      edit(original, "recent A", 65)
      close(original)
      const entered = deferred<void>(), held = deferred<unknown>()
      open(pending, folder, [], () => { entered.resolve(); return held.promise }, false, true)
      const restore = hydrateRestoredWorkspaceState(pending, saved.A, new AbortController().signal, () => instances().has(pending))
      await entered.promise
      open(sibling, folder)
      edit(sibling, "recent B", 66)
      close(sibling)
      if (outcome === "failed") {
        held.reject(new Error("temporary native read failure"))
        await restore
        await settle()
      } else if (outcome === "interrupted") {
        close(pending)
        held.resolve(apiSession("shared", folder))
        await restore
      } else {
        held.resolve(apiSession("shared", folder))
        await restore
        await settle()
        assert.equal(getSessionDraftPrompt(pending, "shared"), "recent A")
        close(pending)
      }

      if (outcome === "completed") {
        const retired = `${key}-retired-original`
        open(retired, folder, ["shared"], undefined, false, true)
        await hydrateRestoredWorkspaceState(retired, saved.A, new AbortController().signal, () => true)
        await settle()
        assert.equal(getSessionDraftPrompt(retired, "shared"), "")
        assert.deepEqual(getAttachments(retired, "shared"), [])
      }
      // A plain opening can take shared B, but it cannot take A's exact bundle.
      const plain = `${key}-plain`
      open(plain, folder, ["shared"])
      await settle()
      assert.equal(getSessionDraftPrompt(plain, "shared"), "recent B")
      close(plain)

      const ids = { A: `${key}-A`, B: `${key}-B` }
      for (const letter of [first, first === "A" ? "B" : "A"] as const) {
        open(ids[letter], folder, ["shared"], undefined, false, true)
        // This snapshot names the occurrence that just published shared B.
        const source = letter === "B" ? plain : outcome === "completed" ? pending : original
        await hydrateRestoredWorkspaceState(ids[letter], { ...saved[letter], workspaceId: source },
          new AbortController().signal, () => true)
        await settle()
        attachInstanceTab(ids[letter], { source: "restore" })
      }
      const captured = captureState(new Map()).state
      const encoded = await encodeClientSnapshotV2({ version: 1, revision: 1, savedAt: 1, layout: {},
        session: { ...captured, activeTabIndex: 0 } })
      const decoded = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
      for (const [letter, byte] of [["A", 65], ["B", 66]] as const) {
        const tab = decoded?.session?.tabs.find(tab => tab.kind === "workspace" && tab.workspaceId === ids[letter])
        assert.equal(tab?.kind, "workspace")
        assert.equal(tab.drafts.shared, `recent ${letter}`)
        close(ids[letter], { drafts: "skip" })
        const reopened = `${ids[letter]}-saved`
        open(reopened, folder, ["shared"], undefined, false, true)
        await hydrateRestoredWorkspaceState(reopened, tab, new AbortController().signal, () => true)
        assert.equal(getSessionDraftPrompt(reopened, "shared"), `recent ${letter}`)
        assert.deepEqual(getAttachments(reopened, "shared").map(({ source }) =>
          source.type === "file" && Array.from(source.data ?? [])), [[byte]])
      }
    })
  }

  it("bounds returned exact bundles and honors a later clear by the same owner", async () => {
    const folder = "/bounded-exact-returns"
    const source = (n: number) => `bounded-exact-owner-${n}`
    const snapshot = (n: number) => ({
      kind: "workspace" as const, folder, workspaceId: source(n), scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      drafts: { shared: `stale ${n}` }, attachments: {},
    })
    for (let n = 0; n <= MAX_CLOSED_WORKSPACE_DRAFTS; n++) {
      open(source(n), folder)
      setSessionDraftPrompt(source(n), "shared", `exact ${n}`)
      close(source(n))
      const id = `${source(n)}-offline`
      open(id, folder, [], async () => { throw new Error("offline") }, false, true)
      await hydrateRestoredWorkspaceState(id, snapshot(n), new AbortController().signal, () => true)
      await settle()
      close(id, { drafts: "skip" })
    }
    for (const [n, expected] of [[0, "stale 0"], [1, "exact 1"]] as const) {
      const id = `${source(n)}-reopen`
      open(id, folder, ["shared"], undefined, false, true)
      await hydrateRestoredWorkspaceState(id, snapshot(n), new AbortController().signal, () => true)
      await settle()
      assert.equal(getSessionDraftPrompt(id, "shared"), expected)
    }

    const newest = MAX_CLOSED_WORKSPACE_DRAFTS
    open(source(newest), folder)
    clearSessionDraftPrompt(source(newest), "shared")
    clearAttachments(source(newest), "shared")
    close(source(newest))
    const id = `${source(newest)}-after-clear`
    open(id, folder, ["shared"], undefined, false, true)
    await hydrateRestoredWorkspaceState(id, snapshot(newest), new AbortController().signal, () => true)
    assert.equal(getSessionDraftPrompt(id, "shared"), "")
    assert.deepEqual(getAttachments(id, "shared"), [])
  })

  it("keeps the exact pending draft when a sibling clears its own copy and closes", async () => {
    const folder = "/exact-pending-sibling-close", original = "pending-original-a", a = "pending-restored-a", b = "pending-cleared-b"
    const file = (byte: number) => createFileAttachment("draft.bin", "draft.bin", "application/octet-stream", new Uint8Array([byte]))
    const descriptor = (workspaceId: string, text: string, byte: number) => ({
      kind: "workspace" as const, folder, workspaceId, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      ...serializeDraftAttachments({ shared: text }, { shared: [file(byte)] }),
    })
    const savedA = descriptor(original, "stale A", 1), savedB = descriptor(b, "stale B", 2)
    open(original, folder)
    setSessionDraftPrompt(original, "shared", "recent A")
    addAttachment(original, "shared", file(65))
    close(original)

    const entered = deferred<void>(), native = deferred<unknown>()
    open(a, folder, [], sessionID => {
      assert.equal(sessionID, "shared")
      entered.resolve()
      return native.promise
    }, false, true)
    const hydration = hydrateRestoredWorkspaceState(a, savedA, new AbortController().signal, () => true)
    attachInstanceTab(a, { source: "restore" })
    await entered.promise
    try {
      open(b, folder)
      setSessionDraftPrompt(b, "shared", "only B")
      addAttachment(b, "shared", file(66))
      clearSessionDraftPrompt(b, "shared")
      clearAttachments(b, "shared")
      close(b)
      const pending = captureState(new Map()).state.tabs.find(tab => tab.kind === "workspace" && tab.workspaceId === a)
      assert.equal(pending?.kind, "workspace")
      assert.equal(pending.drafts.shared, "recent A", "the claimed draft must survive the sibling close while the native read is held")
      assert.equal(pending.attachments.shared?.[0]?.filename, "draft.bin")
    } finally { native.resolve(apiSession("shared", folder)) }
    await hydration
    await settle()

    const reopenedB = `${b}-again`
    open(reopenedB, folder, ["shared"], undefined, false, true)
    await hydrateRestoredWorkspaceState(reopenedB, savedB, new AbortController().signal, () => true)
    attachInstanceTab(reopenedB, { source: "restore" })
    const captured = captureState(new Map()).state
    const encoded = await encodeClientSnapshotV2({ version: 1, revision: 1, savedAt: 1, layout: {},
      session: { ...captured, activeTabIndex: 0 } })
    const decoded = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
    for (const [id, text, bytes] of [[a, "recent A", [[65]]], [reopenedB, "", []]] as const) {
      const tab = decoded?.session?.tabs.find(tab => tab.kind === "workspace" && tab.workspaceId === id)
      assert.equal(tab?.kind, "workspace")
      close(id, { drafts: "skip" })
      const reopened = `${id}-saved`
      open(reopened, folder, ["shared"], undefined, false, true)
      await hydrateRestoredWorkspaceState(reopened, tab, new AbortController().signal, () => true)
      assert.equal(getSessionDraftPrompt(reopened, "shared"), text)
      assert.deepEqual(getAttachments(reopened, "shared").map(({ source }) =>
        source.type === "file" && Array.from(source.data ?? [])), bytes)
    }
  })

  it("fills only empty and untouched bundles on fallback, protecting a file-only snapshot and late typing", async () => {
    const folder = "/vault-bundle-occupancy", from = "vault-bundle-origin", to = "vault-bundle-target"
    const file = createFileAttachment("saved.bin", "saved.bin", "application/octet-stream", new Uint8Array([88]))
    open(from, folder)
    for (const id of ["file-only", "edited", "cleared", "empty"]) {
      setSessionDraftPrompt(from, id, `vault ${id}`)
      addAttachment(from, id, createFileAttachment("vault.bin", "vault.bin", "application/octet-stream", new Uint8Array([65])))
    }
    close(from)

    const held = deferred<unknown>()
    open(to, folder, [], async id => {
      if (id === "edited" || id === "cleared") await held.promise
      return apiSession(id, folder)
    }, false, true)
    const restored = hydrateRestoredWorkspaceState(to, {
      kind: "workspace", folder, workspaceId: "independent", scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      ...serializeDraftAttachments({}, { "file-only": [file] }),
    }, new AbortController().signal, () => true)
    await settle()
    setSessionDraftPrompt(to, "edited", "typed during hydration")
    clearAttachments(to, "cleared")
    held.resolve(null)
    await restored
    await settle()
    assert.equal(getSessionDraftPrompt(to, "file-only"), "")
    assert.deepEqual(getAttachments(to, "file-only").map(({ source }) =>
      source.type === "file" && Array.from(source.data ?? [])), [[88]])
    assert.equal(getSessionDraftPrompt(to, "edited"), "typed during hydration")
    assert.deepEqual(getAttachments(to, "edited"), [])
    assert.equal(getSessionDraftPrompt(to, "cleared"), "")
    assert.deepEqual(getAttachments(to, "cleared"), [])
    assert.equal(getSessionDraftPrompt(to, "empty"), "vault empty")
    assert.deepEqual(getAttachments(to, "empty").map(({ source }) =>
      source.type === "file" && Array.from(source.data ?? [])), [[65]])
  })

  for (const first of ["A", "B"] as const) for (const legacy of [false, true]) {
    it(`keeps independent nonempty drafts when ${first} restores first (${legacy ? "legacy" : "identified"} B)`, async () => {
      const key = `nonempty-${first}-${legacy}`, folder = `/${key}`, original = `${key}-original-A`
      const bytes = (byte: number) => createFileAttachment("proof.bin", "proof.bin", "application/octet-stream", new Uint8Array([byte]))
      const snapshot = (workspaceId: string | undefined, text: string, byte: number) => ({
        kind: "workspace" as const, folder, workspaceId, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
        ...serializeDraftAttachments({ shared: text }, { shared: [bytes(byte)] }),
      })
      const saved = { A: snapshot(original, "stale A", 1), B: snapshot(legacy ? undefined : `${key}-original-B`, "independent B", 66) }
      open(original, folder)
      setSessionDraftPrompt(original, "shared", "new A")
      addAttachment(original, "shared", bytes(65))
      close(original)
      const ids = { A: `${key}-A`, B: `${key}-B` }
      for (const letter of [first, first === "A" ? "B" : "A"] as const) {
        open(ids[letter], folder, ["shared"], undefined, false, true)
        await hydrateRestoredWorkspaceState(ids[letter], saved[letter], new AbortController().signal, () => true)
        await settle()
        attachInstanceTab(ids[letter], { source: "restore" })
      }
      const captured = captureState(new Map()).state
      const encoded = await encodeClientSnapshotV2({ version: 1, revision: 1, savedAt: 1, layout: {}, session: { ...captured, activeTabIndex: 0 } })
      const decoded = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
      for (const letter of ["B", "A"] as const) {
        const tab = decoded?.session?.tabs.find(tab => tab.kind === "workspace" && tab.workspaceId === ids[letter])
        assert.equal(tab?.kind, "workspace")
        const expected = letter === "A" ? "new A" : "independent B"
        assert.equal(tab.drafts.shared, expected)
        close(ids[letter], { drafts: "skip" })
        const reopened = ids[letter] + "-again"
        open(reopened, folder, ["shared"], undefined, false, true)
        await hydrateRestoredWorkspaceState(reopened, tab, new AbortController().signal, () => true)
        assert.equal(getSessionDraftPrompt(reopened, "shared"), expected)
        assert.deepEqual(getAttachments(reopened, "shared").map(({ source }) =>
          source.type === "file" && Array.from(source.data ?? [])), [[letter === "A" ? 65 : 66]])
      }
    })
  }
  for (const first of ["A", "B"] as const) it(`restores ${first} first without borrowing the other occurrence's clear`, async () => {
    const folder = `/ordered-clears-${first}`, a = `ordered-${first}-A`, b = `ordered-${first}-B`
    const binary = (n: number) => createFileAttachment("bytes.bin", "bytes.bin", "application/octet-stream", new Uint8Array([n]))
    const snapshot = (workspaceId: string, occurrence: number, text: string, byte: number) => ({
      kind: "workspace" as const, folder, workspaceId, occurrence, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      ...serializeDraftAttachments({ shared: text }, { shared: [binary(byte)] }),
    })
    const savedA = snapshot(a, 0, "A stale", 65)
    const savedB = snapshot(b, 1, "B independent", 66)
    open(a, folder, ["shared"])
    setSessionDraftPrompt(a, "shared", "A stale")
    addAttachment(a, "shared", binary(65))
    clearSessionDraftPrompt(a, "shared")
    clearAttachments(a, "shared")
    close(a)

    const preservation = createRestorableSessionPreservation({ tabs: [savedA, savedB], activeTabIndex: 0 })
    const openedIds = { A: `${a}-reopen`, B: `${b}-reopen` }
    for (const letter of [first, first === "A" ? "B" : "A"] as const) {
      const id = openedIds[letter]
      open(id, folder, ["shared"], undefined, false, true)
      attachInstanceTab(id)
      recordRestoredTab(preservation, letter === "A" ? 0 : 1, getInstanceAppTabId(id))
      await hydrateRestoredWorkspaceState(id, letter === "A" ? savedA : savedB, new AbortController().signal, () => true)
    }
    const captured = captureState(new Map())
    const state = mergeRestorableSessionState(captured.state, preservation, {
      currentTabIds: captured.tabIds, currentTabAuthorities: captured.authorities,
    })
    const serialized = await encodeClientSnapshotV2({ version: 1, revision: 1, savedAt: 1, layout: {}, session: state })
    const restored = await decodeClientSnapshotV2(serialized.root, 1, async key => serialized.partitions[key] ?? null)
    for (const letter of ["B", "A"] as const) {
      const tab = restored?.session?.tabs.find(tab => tab.kind === "workspace" && tab.workspaceId === openedIds[letter])
      assert.equal(tab?.kind, "workspace")
      assert.equal(tab.drafts.shared, letter === "A" ? undefined : "B independent")
      close(openedIds[letter], { drafts: "skip" })
      const id = `${openedIds[letter]}-again`
      open(id, folder, ["shared"], undefined, false, true)
      await hydrateRestoredWorkspaceState(id, tab, new AbortController().signal, () => true)
      assert.equal(getSessionDraftPrompt(id, "shared"), letter === "A" ? "" : "B independent")
      const bytes = getAttachments(id, "shared").map(({ source }) => source.type === "file" && Array.from(source.data ?? []))
      assert.deepEqual(bytes, letter === "A" ? [] : [[66]])
    }
  })

  it("keeps a folder-only legacy snapshot and leaves the clear for the exact source", async () => {
    const folder = "/ambiguous-legacy-clear", source = "legacy-clear-source"
    const checkpoint = {
      kind: "workspace" as const, folder, occurrence: 0, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      ...serializeDraftAttachments({ shared: "independent legacy text" }, {
        shared: [createFileAttachment("bytes.bin", "bytes.bin", "application/octet-stream", new Uint8Array([77]))],
      }),
    }
    open(source, folder, ["shared"])
    clearSessionDraftPrompt(source, "shared")
    clearAttachments(source, "shared")
    close(source)
    open("legacy-ambiguous", folder, ["shared"], undefined, false, true)
    await hydrateRestoredWorkspaceState("legacy-ambiguous", checkpoint, new AbortController().signal, () => true)
    assert.equal(getSessionDraftPrompt("legacy-ambiguous", "shared"), "independent legacy text")
    const [attachment] = getAttachments("legacy-ambiguous", "shared")
    assert.deepEqual(attachment.source.type === "file" && Array.from(attachment.source.data ?? []), [77])

    open("legacy-exact", folder, ["shared"], undefined, false, true)
    await hydrateRestoredWorkspaceState("legacy-exact", { ...checkpoint, workspaceId: source }, new AbortController().signal, () => true)
    assert.equal(getSessionDraftPrompt("legacy-exact", "shared"), "")
    assert.deepEqual(getAttachments("legacy-exact", "shared"), [])
  })
  it("closing and clearing one occurrence cannot erase an independent saved occurrence", async () => {
    const folder = "/independent-saved-occurrences", session = "shared"
    const binary = (n: number) => createFileAttachment("bytes.bin", "bytes.bin", "application/octet-stream", new Uint8Array([n]))
    const snapshot = {
      kind: "workspace" as const, folder, occurrence: 1, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      ...serializeDraftAttachments({ shared: "B independent" }, { shared: [binary(66)] }),
    }
    open("occurrence-clear-a", folder, [session])
    setSessionDraftPrompt("occurrence-clear-a", session, "A only")
    addAttachment("occurrence-clear-a", session, binary(65))
    const read = deferred<unknown>(), entered = deferred<void>()
    const b = "occurrence-restore-b"
    open(b, folder, [], () => { entered.resolve(); return read.promise }, false, true)
    attachInstanceTab(b, { source: "restore" })
    const restore = hydrateRestoredWorkspaceState(b, snapshot, new AbortController().signal, () => true)
    await entered.promise
    clearSessionDraftPrompt("occurrence-clear-a", session)
    clearAttachments("occurrence-clear-a", session)
    close("occurrence-clear-a")

    const preservation = createRestorableSessionPreservation({ tabs: [snapshot], activeTabIndex: 0 })
    recordRestoredTab(preservation, 0, getInstanceAppTabId(b))
    const checkpoint = () => {
      const captured = captureState(new Map())
      return mergeRestorableSessionState(captured.state, preservation, {
        currentTabIds: captured.tabIds, currentTabAuthorities: captured.authorities,
      })
    }
    try {
      const pending = checkpoint().tabs[0]
      assert.equal(pending.kind, "workspace")
      assert.equal(pending.drafts.shared, "B independent", "checkpoint while native read is pending")
    } finally { read.resolve(apiSession(session, folder)) }
    await restore
    const encoded = await encodeClientSnapshotV2({ version: 1, revision: 1, savedAt: 1, layout: {}, session: checkpoint() })
    const decoded = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
    const saved = decoded?.session?.tabs[0]
    assert.equal(saved?.kind, "workspace")
    assert.equal(saved.drafts.shared, "B independent")
    close(b, { drafts: "skip" })

    // The next vault claim sees A's clear; a different binding then restores B from disk.
    open("occurrence-reopen-a", folder, [session], undefined, false, true)
    await hydrateRestoredWorkspaceState("occurrence-reopen-a", {
      ...snapshot, occurrence: 0, workspaceId: "occurrence-clear-a",
      ...serializeDraftAttachments({ shared: "stale A" }, { shared: [binary(65)] }),
    }, new AbortController().signal, () => true)
    assert.equal(getSessionDraftPrompt("occurrence-reopen-a", session), "")
    assert.deepEqual(getAttachments("occurrence-reopen-a", session), [])
    open("occurrence-reopen-b", folder, [session], undefined, false, true)
    await hydrateRestoredWorkspaceState("occurrence-reopen-b", saved, new AbortController().signal, () => true)
    assert.equal(getSessionDraftPrompt("occurrence-reopen-b", session), "B independent")
    const [file] = getAttachments("occurrence-reopen-b", session)
    assert.deepEqual(file.source.type === "file" && Array.from(file.source.data ?? []), [66])
  })
  for (const clear of [false, true]) for (const vaultFirst of [false, true]) {
    it(`chooses the newer ${clear ? "clear" : "bundle"} independently of ${vaultFirst ? "vault" : "snapshot"} completion`, async () => {
      const key = `draft-authority-${clear}-${vaultFirst}`, folder = `/${key}`, old = `${key}-old`, id = `${key}-reopened`
      const binary = (n: number) => createFileAttachment("bytes.bin", "bytes.bin", "application/octet-stream", new Uint8Array([n]))
      const snapshot = {
        kind: "workspace" as const, folder, workspaceId: old, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
        ...serializeDraftAttachments({ [NO_SESSION]: "independent composer", gone: "old", unrelated: "independent session" },
          { gone: [binary(1)] }),
      }
      open(old, folder, ["gone"])
      setSessionDraftPrompt(old, "gone", "new")
      addAttachment(old, "gone", binary(2))
      if (clear) {
        clearSessionDraftPrompt(old, "gone")
        clearAttachments(old, "gone")
      }
      close(old)
      const vaultRead = deferred<unknown>(), snapshotRead = deferred<unknown>()
      open(id, folder, [], async sessionID => {
        if (sessionID === "unrelated") return snapshotRead.promise
        await vaultRead.promise
        throw { _tag: "SessionNotFoundError", sessionID }
      }, false, true)
      const restored = hydrateRestoredWorkspaceState(id, snapshot, new AbortController().signal, () => true)
      await settle()
      attachInstanceTab(id, { source: "restore" })
      const pending = captureState(new Map()).state.tabs.find(tab => tab.kind === "workspace" && tab.workspaceId === id)
      assert.equal(pending?.kind, "workspace")
      assert.equal(pending.drafts.gone, clear ? undefined : "new")
      if (vaultFirst) {
        vaultRead.resolve(null)
        await settle()
        snapshotRead.resolve(apiSession("unrelated", folder))
        await restored
      } else {
        snapshotRead.resolve(apiSession("unrelated", folder))
        await restored
        vaultRead.resolve(null)
        await settle()
      }
      assert.equal(getSessionDraftPrompt(id, "unrelated"), "independent session")
      assert.equal(getSessionDraftPrompt(id, NO_SESSION), "independent composer")
      assert.equal(recoveredDraftIds(id).length, clear ? 0 : 1)
      const captured = captureState(new Map()).state.tabs.find(tab => tab.kind === "workspace" && tab.workspaceId === id)
      assert.equal(captured?.kind, "workspace")
      const saved = await encodeClientSnapshotV2({ version: 1, revision: 1, savedAt: 1, layout: {},
        session: { tabs: [captured], activeTabIndex: 0 } })
      const decoded = await decodeClientSnapshotV2(saved.root, 1, async key => saved.partitions[key] ?? null)
      const checkpoint = decoded?.session?.tabs[0]
      assert.equal(checkpoint?.kind, "workspace")
      close(id)
      const second = id + "-again"
      open(second, folder, ["unrelated"], undefined, false, true)
      await settle()
      await hydrateRestoredWorkspaceState(second, checkpoint, new AbortController().signal, () => true)
      await settle()
      assert.equal(getSessionDraftPrompt(second, "unrelated"), "independent session")
      assert.equal(getSessionDraftPrompt(second, NO_SESSION), "independent composer")
      const slots = recoveredDraftIds(second)
      assert.equal(slots.length, clear ? 0 : 1)
      if (!clear) {
        switchRecoveredDraft(second, slots[0])
        assert.equal(getSessionDraftPrompt(second, NO_SESSION), "new")
        const [file] = getAttachments(second, NO_SESSION)
        assert.deepEqual(file.source.type === "file" && Array.from(file.source.data ?? []), [2])
      }
    })
  }
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
    const reopened = restoreClosedWorkspaceDrafts("restored-a", "/restored", async () => {})
    read.resolve(apiSession("shared", "/restored"))
    await reopened
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
