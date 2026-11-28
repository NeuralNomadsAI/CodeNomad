import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { backends, createBackendClient, localBackend, type BackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"
import { captureBackendOperation } from "../lib/backend-operation"
import { backendIdOf, parseInstanceKey } from "../lib/backend-identity"
import { allowsAutomaticLocalSetup } from "./app-tabs"
import { selectBrowserOpenOwner, type BrowserOpenResponse } from "../lib/native/browser"
import { getPreviewFrameSource } from "../components/browser-frame-security"
import { closeSessionPreview, dismissSessionPreview, getSessionPreview, openSessionPreview, restoreSessionPreview, sessionPreviews, settleSessionPreviewOpen, showSessionChatFor, showSessionPreview, updateSessionPreviewHistory, updateSessionPreviewViewport } from "./session-previews"
import { detachInstanceTabMembership } from "./app-tab-membership"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { applySurface, beginGesture, getSessionSurface, observeSurfaceGesture, type CentralSurface } from "./session-surface"
import { savedSessionBrowser } from "./session-browser-persistence"
import { initializeClientState } from "./client-state"
import { getTabViewState, seedTabViewState } from "./tab-view-state"

const registry = backends as Map<string, BackendClient>
function fixture(id: string, baseUrl = `https://${id}.example/tenant/`) {
  const calls: { url: string; method: string; body: any }[] = []
  let held = false, token = 0
  const pending: (() => void)[] = []
  const backend = createBackendClient({ id, baseUrl, fetcher: async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? "GET", body })
    if (init?.method === "DELETE") return Response.json({})
    const number = ++token
    if (held) await new Promise<void>(resolve => pending.push(resolve))
    return Response.json({ token: `${id}-${number}`, sessionId: body.sessionId, targetUrl: body.url,
      proxyUrl: `/previews/${id}-${number}/app?q=1#hash`, createdAt: "", capability: `cap-${id}-${number}`,
      contentUrl: `http://cap-${id}-${number}.preview.localhost:1234/previews/${id}-${number}/app?q=1#hash` })
  } })
  registry.set(id, backend)
  let detach = backendEvents.attach(id, backend.events)
  publishInstanceLifecycleAuthority({ type: "opened", instanceId: `${id}~workspace`, folder: "/same", occurrence: 0, backendId: id })
  return { backend, calls, pending, hold: () => { held = true }, release: () => { held = false; pending.splice(0).forEach(resolve => resolve()) },
    detach: () => detach(), reattach: () => { detach = backendEvents.attach(id, backend.events) },
    dispose: () => {
      publishInstanceLifecycleAuthority({ type: "removed", instanceId: `${id}~workspace`, folder: "/same", occurrence: 0, backendId: id })
      detach(); backend.events.dispose(); registry.delete(id)
    } }
}

test("preview store routes creation, replacement and deletion by instance; local keys and URLs stay exact", async t => {
  const a = fixture("preview_a"), b = fixture("preview_b")
  t.after(() => { a.dispose(); b.dispose() })
  t.mock.method(localBackend.api, "createPreview", async ({ sessionId, url }: { sessionId: string; url: string }) => ({ token: "local-token", sessionId, targetUrl: url, proxyUrl: "/previews/local-token/app?q=1#hash", createdAt: "" }))
  t.mock.method(localBackend.api, "deletePreview", async () => {})
  for (const owner of [a, b]) {
    const instanceId = `${owner.backend.id}~workspace`
    const first = await openSessionPreview("same-session", "http://localhost:3000/app?q=1#hash", instanceId)
    assert.equal(first.storageKey, JSON.stringify([instanceId, "same-session"]))
    assert.equal(first.proxyUrl, `/previews/${owner.backend.id}-1/app?q=1#hash`)
    for (const host of ["web", "electron", "tauri"] as const) {
      assert.equal(getPreviewFrameSource({ host, windowContext: "local" }, first, "http://127.0.0.1:9899/src/", owner.backend.id), first.contentUrl)
    }
    const next = await openSessionPreview("same-session", "https://example.com/next", instanceId)
    await closeSessionPreview(next.storageKey)
    assert.deepEqual(owner.calls.map(call => [call.method, new URL(call.url).pathname]), [
      ["POST", "/preview-capabilities"], ["POST", "/preview-capabilities"], ["DELETE", `/preview-capabilities/cap-${owner.backend.id}-1`], ["DELETE", `/preview-capabilities/cap-${owner.backend.id}-2`],
    ])
    assert.deepEqual(owner.calls[0].body, { sessionId: "same-session", url: "http://localhost:3000/app?q=1#hash" })
  }
  publishInstanceLifecycleAuthority({ type: "opened", instanceId: "workspace", folder: "/same", occurrence: 0 })
  const local = await openSessionPreview("same-session", "http://localhost:3000/app?q=1#hash", "workspace")
  assert.equal(local.storageKey, "same-session")
  assert.equal(local.proxyUrl, "/previews/local-token/app?q=1#hash")
  assert.equal(getPreviewFrameSource({ host: "tauri", windowContext: "local" }, local, "http://127.0.0.1:9899/src/"), "http://local-token.preview.localhost:9899/app?q=1#hash")
  await closeSessionPreview(local.storageKey)
})

test("revoked creates clean their own tokens and restore deduplication never joins or clears another generation", async t => {
  const owner = fixture("preview_generation")
  t.after(owner.dispose)
  const localDeletes: string[] = []
  t.mock.method(localBackend.api, "deletePreview", async (token: string) => { localDeletes.push(token) })
  const id = `${owner.backend.id}~workspace`
  const first = await openSessionPreview("session", "https://example.com/saved", id)
  assert.equal(sessionPreviews().get(first.storageKey), first, "published preview is in the live map")
  owner.detach()
  assert.equal(getSessionPreview("session", id), null)
  assert.equal(sessionPreviews().has(first.storageKey), false, "revocation removes the published record, independently of filtered getters")
  assert.deepEqual(owner.calls.filter(call => call.method === "DELETE"), [{
    url: `https://preview_generation.example/preview-capabilities/${first.capability}`, method: "DELETE", body: undefined,
  }], "revocation deletes the exact published token through its owning backend")
  assert.deepEqual(localDeletes, [], "remote token cleanup never falls back to the host")
  owner.reattach(); owner.hold()
  const old = restoreSessionPreview("session", id)
  assert.equal(restoreSessionPreview("session", id), old)
  owner.detach(); owner.reattach()
  const replacement = restoreSessionPreview("session", id)
  assert.notEqual(old, replacement)
  const rejected = assert.rejects(old, { name: "AbortError" })
  owner.pending.shift()!()
  await rejected
  assert.equal(restoreSessionPreview("session", id), replacement)
  owner.release()
  const restored = await replacement
  assert.equal(restored?.token, "preview_generation-3")
  assert.equal(restored?.targetUrl, first.targetUrl)
  assert.ok(owner.calls.some(call => call.method === "DELETE" && call.url.endsWith("/cap-preview_generation-2")))
  await closeSessionPreview(restored!.storageKey)
  owner.hold()
  const opening = openSessionPreview("late", "https://example.com/late", id)
  owner.detach(); owner.release()
  await assert.rejects(opening, /superseded/)
  assert.equal(getSessionPreview("late", id), null)
  assert.ok(owner.calls.some(call => call.method === "DELETE" && call.url.endsWith("/cap-preview_generation-4")))
})

test("missing preview owner refuses create and restore without local requests", async t => {
  let localCalls = 0
  t.mock.method(localBackend.api, "createPreview", async () => { localCalls++; throw new Error("local fallback") })
  publishInstanceLifecycleAuthority({ type: "opened", instanceId: "missing~workspace", folder: "/repo", occurrence: 0, backendId: "missing" })
  seedTabViewState("missing~workspace", { version: 1, previews: { s: { targetUrl: "https://example.com/", mode: "preview" } } })
  await assert.rejects(openSessionPreview("s", "https://example.com/", "missing~workspace"), /Backend unavailable/)
  assert.throws(() => restoreSessionPreview("s", "missing~workspace"), /Backend unavailable/)
  assert.equal(localCalls, 0)
})

test("remote close revokes live authority but retains logical history for explicit reopening", async t => {
  const owner = fixture("preview_close")
  t.after(owner.dispose)
  const id = `${owner.backend.id}~workspace`
  const preview = await openSessionPreview("s", "https://example.com/start", id)
  updateSessionPreviewHistory(preview.storageKey, { urls: ["https://example.com/start", "https://example.com/next"], index: 1 })
  updateSessionPreviewHistory(preview.storageKey, { urls: [preview.contentUrl!], index: 0 })
  assert.equal(getSessionPreview("s", id)?.targetUrl, "https://example.com/next")
  dismissSessionPreview(preview.storageKey)
  assert.equal(getSessionPreview("s", id), null)
  const restored = await restoreSessionPreview("s", id)
  assert.equal(restored?.targetUrl, "https://example.com/next")
  assert.deepEqual(restored?.history, { urls: ["https://example.com/start", "https://example.com/next"], index: 1 })
  assert.notEqual(restored?.capability, preview.capability)
  await closeSessionPreview(restored!.storageKey)
})

test("tab detachment fences pending creates and restore coalescence without touching a replacement", async t => {
  const owner = fixture("preview_tab")
  t.after(owner.dispose)
  const id = `${owner.backend.id}~workspace`
  await openSessionPreview("s", "https://example.com/start", id)
  owner.detach(); owner.reattach(); owner.hold()
  const old = restoreSessionPreview("s", id)
  detachInstanceTabMembership(id)
  const fresh = restoreSessionPreview("s", id)
  assert.notEqual(old, fresh)
  const rejected = assert.rejects(old, { name: "AbortError" })
  owner.pending.shift()!()
  await rejected
  owner.release()
  const restored = await fresh
  assert.equal(getSessionPreview("s", id)?.capability, restored?.capability)
  await closeSessionPreview(restored!.storageKey)
})

test("preview URLs reject embedded credentials and foreign frame sources before publication", async t => {
  const owner = fixture("preview_urls")
  t.after(owner.dispose)
  const id = `${owner.backend.id}~workspace`
  await assert.rejects(openSessionPreview("s", "https://user:secret@localhost/app", id), TypeError)
  assert.equal(owner.calls.length, 0)
  for (const contentUrl of ["https://user:secret@preview_urls.example/previews/t", "https://other.example/previews/t", "javascript:alert(1)"]) {
    t.mock.method(owner.backend.api, "createPreviewCapability", async () => ({ token: "bad", capability: "bad-cap", contentUrl,
      sessionId: "s", targetUrl: "https://example.com/", proxyUrl: "/previews/bad/", createdAt: "" }))
    await assert.rejects(openSessionPreview("s", "https://example.com/", id), TypeError)
    assert.equal(getSessionPreview("s", id), null)
  }
  assert.equal(owner.calls.filter(call => call.method === "DELETE").length, 3)
})

test("a reader/chat gesture during restore stays superseded rather than inviting a default-page open", async t => {
  const owner = fixture("preview_gesture")
  t.after(owner.dispose)
  const id = `${owner.backend.id}~workspace`
  await openSessionPreview("s", "https://example.com/", id)
  owner.detach(); owner.reattach(); owner.hold()
  const restoring = restoreSessionPreview("s", id)
  showSessionChatFor("s", id)
  owner.release()
  await assert.rejects(restoring, { name: "AbortError" })
  assert.equal(getSessionPreview("s", id), null)
})

test("explicit reopen after chat starts a fresh restore without joining or clearing the superseded navigation", async t => {
  const owner = fixture("preview_reopen")
  t.after(owner.dispose)
  const id = `${owner.backend.id}~workspace`
  await openSessionPreview("s", "https://example.com/saved", id)
  owner.detach(); owner.reattach(); owner.hold()
  const old = restoreSessionPreview("s", id)
  showSessionChatFor("s", id)
  const reopened = restoreSessionPreview("s", id)
  const rejected = assert.rejects(old, { name: "AbortError" })
  assert.notEqual(reopened, old)
  assert.equal(owner.pending.length, 2)
  owner.pending.shift()!()
  await rejected
  assert.equal(restoreSessionPreview("s", id), reopened)
  owner.release()
  const restored = await reopened
  assert.equal(restored?.token, "preview_reopen-3")
  assert.equal(restored?.targetUrl, "https://example.com/saved")
  assert.equal(getSessionPreview("s", id)?.token, restored?.token)
  showSessionPreview("s", id)
  assert.equal(getSessionPreview("s", id)?.mode, "preview")
  await closeSessionPreview(restored!.storageKey)
})

test("duplicate remote occurrences isolate gestures, capabilities and recovery across same-name backends", async t => {
  const a = fixture("duplicate_a"), b = fixture("duplicate_b")
  const firstId = `${a.backend.id}~workspace`, siblingId = `${a.backend.id}~sibling`, otherId = `${b.backend.id}~workspace`
  publishInstanceLifecycleAuthority({ type: "opened", instanceId: siblingId, folder: "/same", occurrence: 1, backendId: a.backend.id })
  t.after(() => {
    publishInstanceLifecycleAuthority({ type: "removed", instanceId: siblingId, folder: "/same", occurrence: 1, backendId: a.backend.id })
    a.dispose(); b.dispose()
  })
  const first = await openSessionPreview("same", "https://example.com/first", firstId)
  const sibling = await openSessionPreview("same", "https://example.com/sibling", siblingId)
  const other = await openSessionPreview("same", "https://example.com/other", otherId)
  const siblingIntent = beginGesture({ instanceId: siblingId, sessionId: "same" })
  dismissSessionPreview(first.storageKey)
  assert.equal(siblingIntent.current(), true)
  assert.equal(getSessionPreview("same", siblingId), sibling)
  assert.equal(getSessionPreview("same", otherId), other)
  assert.equal(getTabViewState(firstId).previews?.same.mode, "chat")
  assert.equal(getTabViewState(siblingId).previews?.same.mode, "preview")
  a.hold()
  const pending = restoreSessionPreview("same", firstId)
  a.detach(); a.reattach()
  const fresh = restoreSessionPreview("same", firstId)
  const rejected = assert.rejects(pending, { name: "AbortError" })
  a.pending.shift()!()
  await rejected
  assert.equal(getSessionPreview("same", otherId), other)
  assert.equal(getTabViewState(siblingId).previews?.same.targetUrl, sibling.targetUrl)
  a.release()
  const restored = await fresh
  assert.equal(restored?.targetUrl, first.targetUrl)
  assert.notEqual(restored?.capability, first.capability)
  assert.equal(getSessionPreview("same", siblingId), null, "revocation drops live authority, retaining sibling saved state")
})

function appCallback(name: string, boundaries: Record<string, unknown>, file = "../App.tsx") {
  const source = readFileSync(new URL(file, import.meta.url), "utf8")
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler: string | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) handler = node.initializer?.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(handler, "the production App callback must exist")
  // Execute the exact production callback with its platform/store boundaries supplied.
  const javascript = ts.transpileModule(`const consumer = ${handler}; return consumer;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(boundaries), javascript)(...Object.values(boundaries))
}

test("Electron retires the outstanding load before reading its queued history", async () => {
  const calls: string[] = []
  const observed = "https://example.com/loading"
  const startNavigation = appCallback("startNavigation", {
    browserHost: "electron", browserRegistrationId: "guest", historyGuestId: () => 1,
    props: { openRequestId: "pending" }, capabilities: { history: true }, journal: {},
    untrack: (fn: () => boolean) => fn(), registrationReady: () => true, webviewObservedUrl: observed,
    disposed: false, interruptedCandidate: undefined, preparingHistory: undefined,
    releaseNativeBrowserOpen: async (id: string) => { calls.push(id); return true },
    readBrowserHistory: async () => { calls.push("read"); return { entries: [{ id: 2, url: observed }], index: 0 } },
    retireInterruptedEntry: () => {},
  }, "../components/browser-frame.tsx")
  await startNavigation()
  assert.deepEqual(calls, ["pending", "read"])
})

test("App discovers only admitted local occurrences and prefers the last used tab for the session", async () => {
  const tab = (id: string) => ({ kind: "instance", instance: { id, status: "ready", client: {} } })
  const tabs = [tab("first"), tab("second"), tab("lab~first"), tab("closed")]
  const localInstances = appCallback("localInstances", {
    appTabs: () => tabs, parseInstanceKey, isInstanceOccurrenceOpen: (id: string) => id !== "closed",
  })
  let active = tabs[2]
  const reports: unknown[] = []
  const discover = appCallback("discoverPreviewOwner", {
    localInstances, parseInstanceKey, selectBrowserOpenOwner, activeAppTab: () => active, disposed: false,
    recentTabs: new Map([["session", ["second", "first"]]]),
    claimNativeBrowserOpen: async (_: string, response: unknown) => { reports.push(response); return true },
  })
  await discover({ workspaceIDs: ["first", "closed"], requestID: "one" })
  await discover({ workspaceIDs: ["first", "second"], requestID: "two", sessionID: "session" })
  active = tabs[1]
  await discover({ workspaceIDs: ["first", "second"], requestID: "three" })
  await discover({ workspaceIDs: ["closed"], requestID: "four" })
  assert.deepEqual(reports, [
    { kind: "discover", instanceId: "first" },
    { kind: "discover", instanceId: "second" },
    { kind: "discover", instanceId: "second" },
    { kind: "discover", instanceId: null },
  ])
})

test("autonomous opens respect newer tab selection and save only the exact native commit", async t => {
  const instanceId = "preview-open-tab", duplicate = "preview-duplicate", sessionId = "preview-open-session"
  const url = "https://example.com/request", committed = "https://example.com/committed"
  const deleted: string[] = []
  const requested: string[] = []
  let next = 0
  const layout = new Map<string, string>()
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => layout.get(key) ?? null,
    setItem: (key: string, value: string) => layout.set(key, value),
    removeItem: (key: string) => layout.delete(key),
  } } })
  t.after(() => previousWindow ? Object.defineProperty(globalThis, "window", previousWindow) : Reflect.deleteProperty(globalThis, "window"))
  await initializeClientState()
  t.mock.method(localBackend.api, "createPreview", async ({ url }: { url: string }) => {
    requested.push(url)
    return { token: `${++next}`, sessionId, targetUrl: url, proxyUrl: "/preview", createdAt: "" }
  })
  t.mock.method(localBackend.api, "deletePreview", async (token: string) => { deleted.push(token) })
  publishInstanceLifecycleAuthority({ type: "opened", instanceId, folder: "/same", occurrence: 0 })
  publishInstanceLifecycleAuthority({ type: "opened", instanceId: duplicate, folder: "/same", occurrence: 1 })
  const open = (requestID: string) => {
    const intent = beginGesture({ instanceId, sessionId })
    return openSessionPreview(sessionId, url, instanceId, intent, { requestID, instanceId })
  }
  let selected = duplicate, selectionRevision = 0
  let adopting!: () => void, resume!: () => void
  const adoptionStarted = new Promise<void>(resolve => { adopting = resolve })
  const adoptionGate = new Promise<void>(resolve => { resume = resolve })
  const released: string[] = [], foreground: string[] = []
  const openRequested = appCallback("openRequestedPreview", {
    browserDeliveries: new Map(),
    disposed: false,
    localInstances: () => [{ id: instanceId }, { id: duplicate }],
    appTabSelectionRevision: () => selectionRevision,
    captureBackendOperation, observeSurfaceGesture,
    getSessions: () => [{ id: sessionId }],
    openSessionPreview: async (session: string, url: string, tab: string, intent: ReturnType<typeof beginGesture>, nativeOpen: { requestID: string; instanceId: string }) => {
      if (nativeOpen.requestID === "second") { adopting(); await adoptionGate }
      return openSessionPreview(session, url, tab, intent, nativeOpen)
    },
    releaseNativeBrowserOpen: async (requestID: string) => { released.push(requestID) },
    selectInstanceTab: (id: string) => { selected = id; selectionRevision++ },
    setActiveSessionFromList: (id: string) => foreground.push(id),
  })
  await openRequested({ sessionID: sessionId, url, requestID: "first", instanceId })
  assert.equal(selected, instanceId)
  assert.deepEqual(foreground.splice(0), [instanceId])
  assert.equal(savedSessionBrowser(sessionId), undefined, "an unacknowledged open has no saved destination")
  settleSessionPreviewOpen(sessionId, instanceId, "first")
  assert.equal(getSessionPreview(sessionId, instanceId), null, "a failed first load does not leave an empty preview")
  assert.equal(getSessionSurface({ sessionId, instanceId }).kind, "conversation")
  assert.equal(await restoreSessionPreview(sessionId, duplicate), null)

  const opening = openRequested({ sessionID: sessionId, url, requestID: "second", instanceId })
  await adoptionStarted
  selected = duplicate
  selectionRevision++
  resume()
  await opening
  assert.equal(selected, duplicate, "a newer tab selection must survive the pending adoption")
  assert.deepEqual(foreground, [])
  assert.deepEqual(released, [], "the exact published claim still belongs to the native host")
  const second = getSessionPreview(sessionId, instanceId)!
  assert.equal(second.nativeOpen?.instanceId, instanceId)
  settleSessionPreviewOpen(sessionId, instanceId, "first", committed)
  settleSessionPreviewOpen(sessionId, duplicate, "second", committed)
  updateSessionPreviewHistory(second.storageKey, { urls: [url], index: 0 })
  assert.equal(savedSessionBrowser(sessionId), undefined, "ordinary navigation notifications are not receipts")
  assert.equal(getSessionPreview(sessionId, instanceId)?.token, second.token)
  settleSessionPreviewOpen(sessionId, instanceId, "second", committed)
  assert.deepEqual(savedSessionBrowser(sessionId)?.history, { urls: [committed], index: 0 })
  assert.equal(savedSessionBrowser(sessionId)?.targetUrl, committed)
  const older = "https://example.com/older", forward = "https://example.com/forward"
  updateSessionPreviewHistory(second.storageKey, { urls: [older, committed, forward], index: 1 })
  const saved = savedSessionBrowser(sessionId)

  await open("gesture")
  showSessionChatFor(sessionId, instanceId)
  settleSessionPreviewOpen(sessionId, instanceId, "gesture", url)
  updateSessionPreviewHistory(second.storageKey, { urls: [committed, url], index: 1 })
  assert.equal(getSessionPreview(sessionId, instanceId)?.token, second.token)
  assert.equal(getSessionPreview(sessionId, instanceId)?.nativeOpen, undefined)
  assert.equal(getTabViewState(instanceId).previews?.[sessionId].mode, "chat")
  assert.deepEqual(savedSessionBrowser(sessionId), saved)

  await closeSessionPreview(second.storageKey)
  const failed = await open("fails-with-saved-history")
  updateSessionPreviewHistory(failed.storageKey, { urls: [older, committed, url], index: 2 })
  assert.deepEqual(savedSessionBrowser(sessionId), saved, "pending or failed opens leave the previous cursor intact")
  settleSessionPreviewOpen(sessionId, instanceId, "fails-with-saved-history")
  showSessionChatFor(sessionId, instanceId)
  const restored = await restoreSessionPreview(sessionId, instanceId)
  assert.equal(restored?.targetUrl, committed)
  assert.deepEqual(restored?.history, saved?.history)
  assert.deepEqual(requested, [url, url, url, committed])
  assert.deepEqual(deleted, ["1", "2", "3"])
  await closeSessionPreview(restored!.storageKey)

  const long = await open("unrecordable-commit")
  settleSessionPreviewOpen(sessionId, instanceId, "unrecordable-commit", `https://example.com/${"a".repeat(2049)}`)
  assert.equal(getSessionPreview(sessionId, instanceId)?.token, long.token)
  assert.equal(getSessionPreview(sessionId, instanceId)?.nativeOpen, undefined)
  assert.deepEqual(savedSessionBrowser(sessionId), saved, "a valid but unrecordable URL does not replace saved history")
  await closeSessionPreview(long.storageKey)
})

test("a first agent failure returns to chat and manual reopen starts the default page", async t => {
  const instanceId = "first-agent-failure", sessionId = "no-browser-history"
  publishInstanceLifecycleAuthority({ type: "opened", instanceId, folder: "/same", occurrence: 0 })
  const requested: string[] = []
  t.mock.method(localBackend.api, "createPreview", async ({ url }: { url: string }) => {
    requested.push(url)
    return { token: String(requested.length), sessionId, targetUrl: url, proxyUrl: "/preview", createdAt: "" }
  })
  t.mock.method(localBackend.api, "deletePreview", async () => {})
  await openSessionPreview(sessionId, "https://example.com/unavailable", instanceId, undefined, { requestID: "first", instanceId })
  settleSessionPreviewOpen(sessionId, instanceId, "first")
  assert.equal(getSessionSurface({ sessionId, instanceId }).kind, "conversation")
  const { requestSessionPreview, DEFAULT_PREVIEW_URL } = await import("./session-previews")
  await requestSessionPreview(sessionId, instanceId)
  assert.deepEqual(requested, ["https://example.com/unavailable", DEFAULT_PREVIEW_URL])
  assert.equal(getSessionPreview(sessionId, instanceId)?.targetUrl, DEFAULT_PREVIEW_URL)
  await closeSessionPreview(sessionId)
})

test("an interrupted native open preserves viewport changes and keeps long addresses out of saved history", async t => {
  const instanceId = "preview-admission-tab", sessionId = "preview-admission-session"
  const context = { instanceId, sessionId }
  const lifecycle = { instanceId, folder: "/repo", occurrence: 0 }
  const layout = new Map<string, string>()
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => layout.get(key) ?? null,
    setItem: (key: string, value: string) => layout.set(key, value),
    removeItem: (key: string) => layout.delete(key),
  } } })
  t.after(() => previousWindow ? Object.defineProperty(globalThis, "window", previousWindow) : Reflect.deleteProperty(globalThis, "window"))
  await initializeClientState()
  publishInstanceLifecycleAuthority({ ...lifecycle, type: "opened" })
  t.after(() => publishInstanceLifecycleAuthority({ ...lifecycle, type: "removed" }))
  let token = 0
  t.mock.method(localBackend.api, "createPreview", async ({ url }: { url: string }) =>
    ({ token: String(++token), sessionId, targetUrl: url, proxyUrl: "/preview", createdAt: "" }))
  t.mock.method(localBackend.api, "deletePreview", async () => {})
  const prior = "http://localhost:3000/prior", pending = "http://localhost:3000/pending"
  const long = `http://localhost:3000/report?q=${"a".repeat(2185)}`
  const preview = await openSessionPreview(sessionId, prior, instanceId)
  updateSessionPreviewViewport(preview.storageKey, "desktop")
  const intent = beginGesture(context)
  await openSessionPreview(sessionId, pending, instanceId, intent, { requestID: "slow", instanceId })
  updateSessionPreviewViewport(preview.storageKey, "tablet")
  showSessionChatFor(sessionId, instanceId)
  settleSessionPreviewOpen(sessionId, instanceId, "slow")
  await closeSessionPreview(preview.storageKey)
  const restored = await restoreSessionPreview(sessionId, instanceId)
  assert.equal(restored?.viewport, "tablet")
  assert.equal(restored?.targetUrl, prior)
  const longPreview = await openSessionPreview(sessionId, long, instanceId)
  assert.equal(longPreview.targetUrl, long)
  assert.deepEqual(longPreview.history, { urls: [prior], index: 0 })
  assert.equal(savedSessionBrowser(sessionId)?.targetUrl, prior)
  await closeSessionPreview(longPreview.storageKey)
})

test("a native open does not deliver to a tab closed during session hydration", async t => {
  const controller = new AbortController()
  t.mock.method(backendEvents, "signalForInstance", () => controller.signal)
  const released: string[] = []
  const consume = appCallback("openRequestedPreview", {
    browserDeliveries: new Map(), disposed: false, localInstances: () => [{ id: "tab" }],
    appTabSelectionRevision: () => 0, observeSurfaceGesture: () => ({ current: () => true }),
    captureBackendOperation, getSessions: () => [],
    hydrateRestoredSessionChain: async () => { controller.abort() },
    openSessionPreview: () => assert.fail("closed tab received an open"),
    releaseNativeBrowserOpen: async (id: string) => { released.push(id) },
  })
  await consume({ sessionID: "session", instanceId: "tab", requestID: "delivery", url: "http://localhost/" })
  assert.deepEqual(released, ["delivery"])
})

test("session hydration cannot steal a later selection in the same tab", async () => {
  const instanceId = "hydrating-tab", sessionId = "agent-session"
  let loaded = false, selected = "first"
  const released: string[] = []
  publishInstanceLifecycleAuthority({ instanceId, type: "opened", folder: "/repo", occurrence: 0 })
  const consume = appCallback("openRequestedPreview", {
    browserDeliveries: new Map(), disposed: false, localInstances: () => [{ id: instanceId }],
    appTabSelectionRevision: () => 0, observeSurfaceGesture, captureBackendOperation,
    getSessions: () => loaded ? [{ id: sessionId }] : [],
    hydrateRestoredSessionChain: async () => {
      beginGesture({ instanceId, sessionId: "newer" })
      selected = "newer"
      loaded = true
    },
    openSessionPreview: () => assert.fail("the later selection was ignored"),
    releaseNativeBrowserOpen: async (id: string) => { released.push(id) },
  })
  await consume({ sessionID: sessionId, instanceId, requestID: "delivery", url: "http://localhost/" })
  assert.equal(selected, "newer")
  assert.deepEqual(released, ["delivery"])
})

test("an agent open leaves the owning tab's file and Mission reader in place", async t => {
  const instanceId = "reader-tab", sessionId = "session"
  const context = { instanceId, sessionId }
  publishInstanceLifecycleAuthority({ ...context, type: "opened", folder: "/repo", occurrence: 0 })
  const surfaces: CentralSurface[] = [
    { kind: "file", target: { sessionId, kind: "workspace", slug: "root", directory: "/repo", path: "notes.md" } },
    { kind: "mission", target: { missionId: "mission", kind: "overview" } },
  ]
  const create = t.mock.method(localBackend.api, "createPreview", async () => assert.fail("reader was replaced"))
  const admit = () => assert.fail("preview ownership was requested while a reader is open")
  for (const surface of surfaces) {
    applySurface(context, surface)
    await assert.rejects(openSessionPreview(sessionId, "https://example.com/", instanceId, undefined, { requestID: "agent", instanceId }, undefined, admit), { name: "AbortError" })
    assert.deepEqual(getSessionSurface(context), surface)
  }
  assert.equal(create.mock.callCount(), 0)
})

test("App automatic host setup follows the selected live or restoring backend without gating remote tabs", () => {
  let active: any, saved: any
  const automatic = appCallback("automaticLocalSetup", {
    activeAppTab: () => active, loadedRestorableSession: () => saved, allowsAutomaticLocalSetup, backendIdOf,
  })
  assert.equal(automatic(), true)
  saved = { tabs: [{ kind: "workspace", folder: "/same", backendId: "remote" }], activeTabIndex: 0 }
  assert.equal(automatic(), false, "saved remote selection refuses automatic local setup before its live tab arrives")
  active = { kind: "remote-restore" }
  assert.equal(automatic(), false)
  active = { kind: "instance", instance: { id: "remote~same" } }
  assert.equal(automatic(), false)
  active = { kind: "instance", instance: { id: "same" } }
  assert.equal(automatic(), true)
})
