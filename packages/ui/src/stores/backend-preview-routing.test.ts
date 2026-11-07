import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { backends, createBackendClient, localBackend, type BackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"
import { captureBackendOperation } from "../lib/backend-operation"
import { projectScope, parseInstanceKey } from "../lib/backend-identity"
import { selectBrowserOpenOwner } from "../lib/native/browser"
import { getPreviewFrameSource } from "../components/browser-frame-security"
import { closeSessionPreview, getSessionPreview, openSessionPreview, restoreSessionPreview, sessionPreviews, showSessionChatFor, showSessionPreview } from "./session-previews"

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
      proxyUrl: `/previews/${id}-${number}/app?q=1#hash`, createdAt: "" })
  } })
  registry.set(id, backend)
  let detach = backendEvents.attach(id, backend.events)
  return { backend, calls, pending, hold: () => { held = true }, release: () => { held = false; pending.splice(0).forEach(resolve => resolve()) },
    detach: () => detach(), reattach: () => { detach = backendEvents.attach(id, backend.events) },
    dispose: () => { detach(); backend.events.dispose(); registry.delete(id) } }
}

test("preview store routes creation, replacement and deletion by instance; local keys and URLs stay exact", async t => {
  const a = fixture("preview_a"), b = fixture("preview_b")
  t.after(() => { a.dispose(); b.dispose() })
  t.mock.method(localBackend.api, "createPreview", async ({ sessionId, url }: { sessionId: string; url: string }) => ({ token: "local-token", sessionId, targetUrl: url, proxyUrl: "/previews/local-token/app?q=1#hash", createdAt: "" }))
  t.mock.method(localBackend.api, "deletePreview", async () => {})
  for (const owner of [a, b]) {
    const scope = projectScope({ folder: "/same", backendId: owner.backend.id }), instanceId = `${owner.backend.id}~workspace`
    const first = await openSessionPreview("same-session", "http://localhost:3000/app?q=1#hash", scope, instanceId)
    assert.equal(first.storageKey, JSON.stringify([scope, "same-session"]))
    assert.equal(first.proxyUrl, `https://${owner.backend.id}.example/previews/${owner.backend.id}-1/app?q=1#hash`)
    for (const host of ["web", "electron", "tauri"] as const) {
      assert.equal(getPreviewFrameSource({ host, windowContext: "local" }, first, "http://127.0.0.1:9899/src/", owner.backend.id), first.proxyUrl)
    }
    const next = await openSessionPreview("same-session", "https://example.com/next", scope, instanceId)
    await closeSessionPreview(next.storageKey)
    assert.deepEqual(owner.calls.map(call => [call.method, new URL(call.url).pathname]), [
      ["POST", "/api/previews"], ["POST", "/api/previews"], ["DELETE", `/api/previews/${owner.backend.id}-1`], ["DELETE", `/api/previews/${owner.backend.id}-2`],
    ])
    assert.deepEqual(owner.calls[0].body, { sessionId: "same-session", url: "http://localhost:3000/app?q=1#hash" })
  }
  const local = await openSessionPreview("same-session", "http://localhost:3000/app?q=1#hash", "/same", "workspace")
  assert.equal(local.storageKey, JSON.stringify(["/same", "same-session"]))
  assert.equal(local.proxyUrl, "/previews/local-token/app?q=1#hash")
  assert.equal(getPreviewFrameSource({ host: "tauri", windowContext: "local" }, local, "http://127.0.0.1:9899/src/"), "http://local-token.preview.localhost:9899/app?q=1#hash")
  await closeSessionPreview(local.storageKey)
})

test("revoked creates clean their own tokens and restore deduplication never joins or clears another generation", async t => {
  const owner = fixture("preview_generation")
  t.after(owner.dispose)
  const localDeletes: string[] = []
  t.mock.method(localBackend.api, "deletePreview", async (token: string) => { localDeletes.push(token) })
  const scope = projectScope({ folder: "/race", backendId: owner.backend.id }), id = `${owner.backend.id}~workspace`
  const first = await openSessionPreview("session", "https://example.com/saved", scope, id)
  assert.equal(sessionPreviews().get(first.storageKey), first, "published preview is in the live map")
  owner.detach()
  assert.equal(getSessionPreview("session", scope), null)
  assert.equal(sessionPreviews().has(first.storageKey), false, "revocation removes the published record, independently of filtered getters")
  assert.deepEqual(owner.calls.filter(call => call.method === "DELETE"), [{
    url: `https://preview_generation.example/api/previews/${first.token}`, method: "DELETE", body: undefined,
  }], "revocation deletes the exact published token through its owning backend")
  assert.deepEqual(localDeletes, [], "remote token cleanup never falls back to the host")
  owner.reattach(); owner.hold()
  const old = restoreSessionPreview("session", scope, id)
  assert.equal(restoreSessionPreview("session", scope, id), old)
  owner.detach(); owner.reattach()
  const replacement = restoreSessionPreview("session", scope, id)
  assert.notEqual(old, replacement)
  owner.pending.shift()!()
  assert.equal(await old, null)
  assert.equal(restoreSessionPreview("session", scope, id), replacement)
  owner.release()
  const restored = await replacement
  assert.equal(restored?.token, "preview_generation-3")
  assert.equal(restored?.targetUrl, first.targetUrl)
  assert.ok(owner.calls.some(call => call.method === "DELETE" && call.url.endsWith("/preview_generation-2")))
  await closeSessionPreview(restored!.storageKey)
  owner.hold()
  const opening = openSessionPreview("late", "https://example.com/late", scope, id)
  owner.detach(); owner.release()
  await assert.rejects(opening, /superseded/)
  assert.equal(getSessionPreview("late", scope), null)
  assert.ok(owner.calls.some(call => call.method === "DELETE" && call.url.endsWith("/preview_generation-4")))
})

test("missing preview owner refuses create and restore without local requests", async t => {
  let localCalls = 0
  t.mock.method(localBackend.api, "createPreview", async () => { localCalls++; throw new Error("local fallback") })
  await assert.rejects(openSessionPreview("s", "https://example.com/", "missing~/repo", "missing~workspace"), /Backend unavailable/)
  assert.throws(() => restoreSessionPreview("s", "missing~/repo", "missing~workspace"), /Backend unavailable/)
  assert.equal(localCalls, 0)
})

test("preview URLs reject embedded credentials and foreign frame sources before publication", async t => {
  const owner = fixture("preview_urls")
  t.after(owner.dispose)
  const id = `${owner.backend.id}~workspace`, scope = `${owner.backend.id}~/repo`
  await assert.rejects(openSessionPreview("s", "https://user:secret@localhost/app", scope, id), TypeError)
  assert.equal(owner.calls.length, 0)
  for (const proxyUrl of ["https://user:secret@preview_urls.example/previews/t", "https://other.example/previews/t", "javascript:alert(1)"]) {
    t.mock.method(owner.backend.api, "createPreview", async () => ({ token: "bad", sessionId: "s", targetUrl: "https://example.com/", proxyUrl, createdAt: "" }))
    await assert.rejects(openSessionPreview("s", "https://example.com/", scope, id), TypeError)
    assert.equal(getSessionPreview("s", scope), null)
  }
  assert.equal(owner.calls.filter(call => call.method === "DELETE").length, 3)
})

test("a reader/chat gesture during restore stays superseded rather than inviting a default-page open", async t => {
  const owner = fixture("preview_gesture")
  t.after(owner.dispose)
  const id = `${owner.backend.id}~workspace`, scope = `${owner.backend.id}~/repo`
  await openSessionPreview("s", "https://example.com/", scope, id)
  owner.detach(); owner.reattach(); owner.hold()
  const restoring = restoreSessionPreview("s", scope, id)
  showSessionChatFor("s", scope)
  owner.release()
  await assert.rejects(restoring, { name: "AbortError" })
  assert.equal(getSessionPreview("s", scope), null)
})

test("explicit reopen after chat starts a fresh restore without joining or clearing the superseded navigation", async t => {
  const owner = fixture("preview_reopen")
  t.after(owner.dispose)
  const id = `${owner.backend.id}~workspace`, scope = `${owner.backend.id}~/repo`
  await openSessionPreview("s", "https://example.com/saved", scope, id)
  owner.detach(); owner.reattach(); owner.hold()
  const old = restoreSessionPreview("s", scope, id)
  showSessionChatFor("s", scope)
  const reopened = restoreSessionPreview("s", scope, id)
  const rejected = assert.rejects(old, { name: "AbortError" })
  assert.notEqual(reopened, old)
  assert.equal(owner.pending.length, 2)
  owner.pending.shift()!()
  await rejected
  assert.equal(restoreSessionPreview("s", scope, id), reopened)
  owner.release()
  const restored = await reopened
  assert.equal(restored?.token, "preview_reopen-3")
  assert.equal(restored?.targetUrl, "https://example.com/saved")
  assert.equal(getSessionPreview("s", scope)?.token, restored?.token)
  showSessionPreview(restored!.storageKey)
  assert.equal(getSessionPreview("s", scope)?.mode, "preview")
  await closeSessionPreview(restored!.storageKey)
})

function appNativeBrowserOpen(boundaries: Record<string, unknown>) {
  const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8")
  const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "openRequestedPreview") handler = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(handler, "the production App callback must exist")
  // Execute the exact production callback with its platform/store boundaries supplied.
  const javascript = ts.transpileModule(`const consumer = ${handler.getText(ast)}; return consumer;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(boundaries), javascript)(...Object.values(boundaries)) as (session: string, url: string, request: string) => Promise<void>
}

test("App host-native browser-open consumer excludes colliding remote owners and remote hydration", async () => {
  for (const scenario of ["loaded", "hydrate", "remote-only"] as const) {
    const local = { id: "same", folder: "/same", client: {} }, remote = { id: "lab~same", folder: "/same", backendId: "lab", client: {} }
    const projects = new Map(scenario === "remote-only" ? [[remote.id, remote]] : [[local.id, local], [remote.id, remote]])
    const sessions = new Map([[remote.id, [{ id: "collision" }]], [local.id, scenario === "loaded" ? [{ id: "collision" }] : []]])
    const fetched: string[] = [], opened: unknown[][] = [], claimed: string[] = [], selected: string[] = []
    const boundaries = {
      instances: () => projects, getSessions: (id: string) => sessions.get(id) ?? [],
      parseInstanceKey, projectScope, selectBrowserOpenOwner, captureBackendOperation, disposed: false,
      activeAppTab: () => ({ kind: "instance", instance: remote }),
      fetchSessions: async (id: string) => { fetched.push(id); sessions.set(id, [{ id: "collision" }]) },
      claimNativeBrowserOpen: async (id: string) => { claimed.push(id); return true },
      releaseNativeBrowserOpen: async () => {}, openSessionPreview: async (...args: unknown[]) => { opened.push(args) },
      setShowFolderSelection: () => {}, selectInstanceTab: (id: string) => selected.push(id),
      setActiveSessionFromList: () => {}, log: { warn: () => {} },
    }
    const consumer = appNativeBrowserOpen(boundaries)
    await consumer("collision", "http://localhost:3000/app", "host-request")
    if (scenario === "remote-only") {
      assert.deepEqual(opened, []); assert.deepEqual(claimed, []); assert.deepEqual(selected, [])
    } else {
      assert.deepEqual(opened, [["collision", "http://localhost:3000/app", "/same", "same"]])
      assert.deepEqual(claimed, ["host-request"]); assert.deepEqual(selected, ["same"])
    }
    assert.deepEqual(fetched, scenario === "hydrate" ? ["same"] : [])
  }
})

test("App native browser claim and preview continuations retain the admitted attachment and owner", async t => {
  for (const phase of ["claim", "open"] as const) {
    for (const revoke of ["detach", "remove", "session"] as const) {
      const controller = new AbortController()
      t.mock.method(backendEvents, "signalForInstance", () => controller.signal)
      const local = { id: "same", folder: "/same", client: {} }
      const projects = new Map([[local.id, local]])
      let sessions = [{ id: "collision" }]
      let resume!: () => void, admitted!: () => void
      const gate = new Promise<void>(resolve => { resume = resolve })
      const waiting = new Promise<void>(resolve => { admitted = resolve })
      const opened: unknown[][] = [], released: string[] = [], claimed: string[] = [], navigated: string[] = [], fetched: string[] = []
      const consumer = appNativeBrowserOpen({
        instances: () => projects, getSessions: () => sessions,
        parseInstanceKey, projectScope, selectBrowserOpenOwner, captureBackendOperation, disposed: false,
        activeAppTab: () => ({ kind: "instance", instance: local }),
        fetchSessions: async (id: string) => { fetched.push(id) },
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
      const opening = consumer("collision", "http://localhost:3000/app", request)
      await waiting
      if (revoke === "detach") controller.abort()
      else if (revoke === "remove") projects.delete(local.id)
      else sessions = []
      resume()
      await opening
      assert.deepEqual(claimed, [request])
      assert.deepEqual(released, [request], `${phase}/${revoke}: release the exact admitted claim once`)
      assert.equal(opened.length, phase === "claim" ? 0 : 1)
      assert.deepEqual(fetched, [])
      assert.deepEqual(navigated, [])
      t.mock.restoreAll()
    }
  }
})
