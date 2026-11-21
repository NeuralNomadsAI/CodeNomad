import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { backends, createBackendClient, localBackend, type BackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"
import { captureBackendOperation } from "../lib/backend-operation"
import { backendIdOf, parseInstanceKey } from "../lib/backend-identity"
import { selectBrowserOpenOwner } from "../lib/native/browser"
import { getPreviewFrameSource } from "../components/browser-frame-security"
import { closeSessionPreview, dismissSessionPreview, getSessionPreview, openSessionPreview, restoreSessionPreview, sessionPreviews, settleSessionPreviewOpen, showSessionChatFor, showSessionPreview, updateSessionPreviewHistory } from "./session-previews"
import { detachInstanceTabMembership } from "./app-tab-membership"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { beginGesture } from "./session-surface"
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
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) handler = node.getText(ast).replace(/^export /, "")
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

test("App discovers only admitted local occurrences, reports the active one and refuses ambiguity without hydration", async () => {
  const tab = (id: string) => ({ kind: "instance", instance: { id, status: "ready", client: {} } })
  const tabs = [tab("first"), tab("second"), tab("lab~first"), tab("closed")]
  const localInstances = appCallback("localInstances", {
    appTabs: () => tabs, parseInstanceKey, isInstanceOccurrenceOpen: (id: string) => id !== "closed",
  })
  let active = tabs[2]
  const reports: unknown[] = []
  const discover = appCallback("discoverPreviewOwner", {
    localInstances, parseInstanceKey, selectBrowserOpenOwner, activeAppTab: () => active, disposed: false,
    claimNativeBrowserOpen: async (_: string, response: unknown) => { reports.push(response); return true },
  })
  await discover({ workspaceIDs: ["first", "closed"], requestID: "one" })
  await discover({ workspaceIDs: ["first", "second"], requestID: "two" })
  active = tabs[1]
  await discover({ workspaceIDs: ["first", "second"], requestID: "three" })
  await discover({ workspaceIDs: ["closed"], requestID: "four" })
  assert.deepEqual(reports, [
    { kind: "discover", instanceId: "first" },
    { kind: "discover", ambiguous: true },
    { kind: "discover", instanceId: "second" },
    { kind: "discover", instanceId: null },
  ])
})

test("autonomous opens save only an exact, current native commit across duplicate occurrences", async t => {
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
    return openSessionPreview(sessionId, url, instanceId, async () => true, intent,
      { requestID, instanceId, current: intent.current })
  }
  await open("first")
  assert.equal(savedSessionBrowser(sessionId), undefined, "an unacknowledged open has no saved destination")
  settleSessionPreviewOpen(sessionId, instanceId, "first")
  assert.equal(getSessionPreview(sessionId, instanceId), null)
  assert.equal(await restoreSessionPreview(sessionId, duplicate), null)

  const second = await open("second")
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
  assert.equal(getSessionPreview(sessionId, instanceId)?.token, second.token)
  assert.equal(getSessionPreview(sessionId, instanceId)?.nativeOpen, undefined)
  assert.equal(getTabViewState(instanceId).previews?.[sessionId].mode, "chat")
  assert.deepEqual(savedSessionBrowser(sessionId), saved)

  await closeSessionPreview(second.storageKey)
  const failed = await open("fails-with-saved-history")
  updateSessionPreviewHistory(failed.storageKey, { urls: [older, committed, url], index: 2 })
  assert.deepEqual(savedSessionBrowser(sessionId), saved, "pending or failed opens leave the previous cursor intact")
  settleSessionPreviewOpen(sessionId, instanceId, "fails-with-saved-history")
  const restored = await restoreSessionPreview(sessionId, duplicate)
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

test("App native browser claim and preview continuations retain the admitted attachment and owner", async t => {
  for (const phase of ["claim", "open"] as const) {
    for (const revoke of ["detach", "remove", "session", "retired"] as const) {
      const controller = new AbortController()
      t.mock.method(backendEvents, "signalForInstance", () => controller.signal)
      const local = { id: "same", folder: "/same", client: {}, status: "ready" }
      const projects = new Map([[local.id, local]])
      let sessions = [{ id: "collision" }]
      let resume!: () => void, admitted!: () => void
      const gate = new Promise<void>(resolve => { resume = resolve })
      const waiting = new Promise<void>(resolve => { admitted = resolve })
      const opened: unknown[][] = [], released: string[] = [], claimed: string[] = [], navigated: string[] = [], fetched: string[] = []
      const pendingBrowserOpens = new Map<string, { sessionID: string; retire: () => void }>()
      let gestures = 0
      const consumer = appCallback("openRequestedPreview", {
        pendingBrowserOpens,
        localInstances: () => [...projects.values()],
        getSessions: () => sessions,
        parseInstanceKey, beginGesture: () => { gestures++; return { current: () => true } }, selectBrowserOpenOwner, captureBackendOperation, disposed: false,
        activeAppTab: () => ({ kind: "instance", instance: local }),
        hydrateRestoredSessionChain: async (id: string) => { fetched.push(id) },
        getSessionPreview: () => null,
        claimNativeBrowserOpen: async (request: string) => {
          claimed.push(request)
          if (phase === "claim") { admitted(); await gate }
          return true
        },
        openSessionPreview: async (...args: unknown[]) => {
          opened.push(args)
          if (phase === "open") { admitted(); await gate }
        },
        releaseNativeBrowserOpen: async (request: string) => { released.push(request) },
        setShowFolderSelection: () => navigated.push("home"), selectInstanceTab: () => navigated.push("tab"),
        setActiveSessionFromList: () => navigated.push("session"), log: { warn: () => {} },
      })
      const request = `host-${phase}-${revoke}`
      const opening = consumer({ sessionID: "collision", url: "http://localhost:3000/app", requestID: request, instanceId: local.id })
      await waiting
      await consumer({ sessionID: "collision", url: "http://localhost:3000/duplicate", requestID: "duplicate", instanceId: local.id })
      assert.equal(gestures, 1, "refusing a duplicate must not invalidate the already admitted gesture")
      if (revoke === "detach") controller.abort()
      else if (revoke === "remove") projects.delete(local.id)
      else if (revoke === "retired") pendingBrowserOpens.get(request)?.retire()
      else sessions = []
      resume()
      await opening
      assert.deepEqual(claimed, [request])
      assert.deepEqual(released, ["duplicate", request], `${phase}/${revoke}: release each exact claim once`)
      assert.equal(opened.length, phase === "claim" ? 0 : 1)
      assert.deepEqual(fetched, [])
      assert.deepEqual(navigated, [])
      t.mock.restoreAll()
    }
  }
})

test("App automatic host setup follows the selected live or restoring backend without gating remote tabs", () => {
  let active: any, saved: any
  const automatic = appCallback("automaticLocalSetup", {
    activeAppTab: () => active, loadedRestorableSession: () => saved, parseInstanceKey, backendIdOf,
    allowsAutomaticLocalSetup: appCallback("allowsAutomaticLocalSetup", { parseInstanceKey }, "./app-tabs.ts"),
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
