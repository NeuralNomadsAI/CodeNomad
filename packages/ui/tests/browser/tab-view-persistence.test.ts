import assert from "node:assert/strict"
import { createServer, request as forwardRequest } from "node:http"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string, webUrl: string
before(async () => {
  const fixture = await borrowFixture({ name: "tab-view-persistence", routes: [
    { path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/project-tab-restore.tsx"></script></body></html>' },
    { path: "/web", html: '<html><body><script type="module" src="/tests/browser/fixtures/tab-view-web-persistence.tsx"></script></body></html>' },
  ] })
  url = fixture.url; webUrl = url.replace(/\/fixture$/, "/web")
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("occurrence browser data merges into one session resource before lazy restoration", async () => {
  const page = await browser.newPage()
  try {
    await page.addInitScript(() => {
      const w = window as any
      w.__name = (value: unknown) => value
      w.__CODENOMAD_RUNTIME_HOST__ = "web"; w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
      w.EventSource = class extends EventTarget { close() {} }
      if (sessionStorage.getItem("migration-seeded")) return
      sessionStorage.setItem("migration-seeded", "true")
      localStorage.setItem("opencode-session-tab-views-v1", JSON.stringify(Object.fromEntries([0, 1].map(index => [
        JSON.stringify(["/same", index]), { version: 1, previews: { same: {
          mode: index ? "chat" : "preview", targetUrl: `https://example.com/${index}`,
          history: { urls: ["https://example.com/start", `https://example.com/${index}`], index: 1 },
          viewport: index ? "mobile" : "desktop",
        } } },
      ]))))
    })
    await page.route("**/api/**", route => route.fulfill({ json: [] }))
    await page.goto(webUrl); await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.evaluate(() => (window as any).fixture.created()), 0)
    assert.deepEqual(await page.evaluate(() => ["web-a", "web-b"].map(id => (window as any).fixture.view(id).previews.same)),
      [{ mode: "preview" }, { mode: "chat" }])
    const saved = await page.evaluate(() => (window as any).fixture.saved("same"))
    assert.equal(saved.targetUrl, "https://example.com/1", "most recently written occurrence supplies the shared browser")
    assert.equal(saved.viewport, "mobile")
    assert.deepEqual(saved.history, { urls: ["https://example.com/start", "https://example.com/1"], index: 1 })
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.evaluate(() => (window as any).fixture.created()), 0)
    const restored = await page.evaluate(async () => {
      const f = (window as any).fixture
      const a = await f.restore("same", "web-a"), b = await f.restore("same", "web-b")
      return [a.token, b.token, a.targetUrl, b.targetUrl, f.created()]
    })
    assert.deepEqual(restored, ["web-1", "web-1", "https://example.com/1", "https://example.com/1", 1])
  } finally { await page.close() }
})

for (const remote of [false, true]) for (const exactFirst of [false, true]) {
  test(`${remote ? "desktop remote" : "storage-unavailable web"} legacy session adoption merges sequential sessions, exact first=${exactFirst}`, async () => {
    const page = await browser.newPage()
    try {
      await page.addInitScript(({ remote, exactFirst }) => {
        const w = window as any
        w.__name = (value: unknown) => value
        w.__CODENOMAD_RUNTIME_HOST__ = remote ? "electron" : "web"
        w.__CODENOMAD_WINDOW_CONTEXT__ = remote ? "remote" : "local"
        w.EventSource = class extends EventTarget { close() {} }
        if (sessionStorage.getItem("legacy-seeded")) return
        sessionStorage.setItem("legacy-seeded", "true")
        const preview = (name: string) => ({ mode: "chat", targetUrl: `https://example.com/${name}` })
        const exact = [JSON.stringify(["/same", "one"]), preview("one")]
        const project = ["/same", preview("project")]
        localStorage.setItem("opencode-session-previews-v1", JSON.stringify(Object.fromEntries([
          ...(exactFirst ? [exact, project] : [project, exact]), [JSON.stringify(["/same", "two"]), preview("two")],
        ])))
      }, { remote, exactFirst })
      await page.route("**/api/**", route => route.fulfill({ json: [] }))
      await page.goto(webUrl); await page.waitForFunction(() => Boolean((window as any).fixture))
      assert.equal(await page.evaluate(async () => (await (window as any).fixture.restore("one", "web-a")).targetUrl), "https://example.com/one")
      const remaining = await page.evaluate(() => JSON.parse(localStorage.getItem("opencode-session-previews-v1")!))
      assert.deepEqual(Object.keys(remaining).sort(), ["/same", JSON.stringify(["/same", "two"])].sort(), "only the exact consumed source retires")
      assert.equal(await page.evaluate(async () => (await (window as any).fixture.restore("two", "web-a")).targetUrl), "https://example.com/two")
      assert.deepEqual(await page.evaluate(() => Object.values((window as any).fixture.browsers()).map((p: any) => p.targetUrl)),
        ["https://example.com/one", "https://example.com/two"], "adopting the next session preserves the first")
      assert.equal(await page.evaluate(async () => (await (window as any).fixture.restore("three", "web-a")).targetUrl), "https://example.com/project")
      assert.equal(await page.evaluate(() => localStorage.getItem("opencode-session-previews-v1")), "{}")
      await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
      assert.deepEqual(await page.evaluate(() => Object.values((window as any).fixture.browsers()).map((p: any) => p.targetUrl)),
        ["https://example.com/one", "https://example.com/two", "https://example.com/project"])
      assert.equal(await page.evaluate(() => (window as any).fixture.created()), 0)
    } finally { await page.close() }
  })
}

for (const remote of [false, true]) test(`${remote ? "desktop remote" : "storage-unavailable web"} duplicate opened during held DELETE keeps its compacted view after reload`, async () => {
  const page = await browser.newPage()
  let release!: () => void, reached!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), arrival = new Promise<void>(resolve => { reached = resolve })
  try {
    await page.addInitScript(remote => {
      const w = window as any
      w.__name = (value: unknown) => value
      w.__CODENOMAD_RUNTIME_HOST__ = remote ? "electron" : "web"; w.__CODENOMAD_WINDOW_CONTEXT__ = remote ? "remote" : "local"
      w.EventSource = class extends EventTarget { close() {} }
    }, remote)
    await page.route("**/api/**", async route => {
      if (route.request().method() === "DELETE" && new URL(route.request().url()).pathname === "/api/workspaces/web-a") {
        reached(); await hold
        await route.fulfill({ status: 204 })
        return
      }
      await route.fulfill({ json: [] })
    })
    await page.goto(webUrl); await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(async () => {
      const f = (window as any).fixture
      await f.open("same", "https://example.com/a", "web-a")
      await f.open("same", "https://example.com/b", "web-b")
      f.close("web-a")
    })
    await arrival
    await page.evaluate(async () => {
      const f = (window as any).fixture
      f.add("web-c")
      await f.open("same", "https://example.com/c", "web-c")
    })
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.ids()), ["web-a", "web-b", "web-c"], "closing workspace remains in backend inventory")
    const deleted = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().endsWith("/api/workspaces/web-a"))
    release(); await deleted
    await page.evaluate(() => (window as any).fixture.removed("web-a"))
    await page.waitForFunction(() => !(window as any).fixture.ids().includes("web-a"))
    await page.evaluate(() => sessionStorage.setItem("workspace-inventory", JSON.stringify((window as any).fixture.ids())))
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.deepEqual(await page.evaluate(() => ["web-b", "web-c"].map(id => (window as any).fixture.view(id).previews?.same)),
      [{ mode: "preview" }, { mode: "preview" }])
    assert.equal(await page.evaluate(() => (window as any).fixture.saved("same").targetUrl), "https://example.com/c")
    assert.equal(await page.evaluate(() => (window as any).fixture.created()), 0)
  } finally { release(); await page.close() }
})

for (const remote of [false, true]) test(`${remote ? "desktop remote" : "storage-unavailable web"} previews persist through the production lifecycle and adopt legacy URLs`, async () => {
  const page = await browser.newPage()
  try {
    await page.addInitScript(({ remote }) => {
      const w = window as any
      w.__name = (value: unknown) => value
      w.__CODENOMAD_RUNTIME_HOST__ = remote ? "electron" : "web"
      w.__CODENOMAD_WINDOW_CONTEXT__ = remote ? "remote" : "local"
      w.EventSource = class extends EventTarget { close() {} }
    }, { remote })
    await page.route("**/api/**", route => route.fulfill({ json: [] }))
    await page.goto(webUrl); await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(async () => {
      const f = (window as any).fixture
      const a = await f.open("same", "https://example.com/a", "web-a")
      f.history(a.sessionId, { urls: ["https://example.com/a", "https://example.com/next"], index: 1 })
      f.viewport(a.sessionId, "mobile")
      await f.open("same", "https://example.com/b", "web-b")
      f.hide("same", "web-b")
      await f.flush()
    })
    assert.equal(await page.evaluate(() => (window as any).fixture.state()), null, "non-native clients never acquire a native snapshot")
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    const views = await page.evaluate(() => ["web-a", "web-b"].map(id => (window as any).fixture.view(id).previews.same))
    assert.deepEqual(views, [{ mode: "preview" }, { mode: "chat" }])
    const saved = await page.evaluate(() => (window as any).fixture.saved("same"))
    assert.equal(saved.targetUrl, "https://example.com/b")
    assert.deepEqual(saved.history, { urls: ["https://example.com/a", "https://example.com/next", "https://example.com/b"], index: 2 })
    assert.equal(saved.viewport, "mobile")
    assert.equal(await page.evaluate(() => (window as any).fixture.created()), 0)
    await page.evaluate(async () => { await (window as any).fixture.restore("same", "web-a"); await (window as any).fixture.flush() })
    assert.equal(await page.evaluate(() => (window as any).fixture.preview("same", "web-a").targetUrl), "https://example.com/b")
    await page.evaluate(() => (window as any).fixture.close("web-a"))
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.evaluate(() => (window as any).fixture.view("web-a").previews.same.mode), "chat",
      "the surviving duplicate retains its view when backend occurrence ranks compact")
    assert.equal(await page.evaluate(() => (window as any).fixture.view("web-b").previews), undefined)
    await page.evaluate(() => {
      localStorage.removeItem("opencode-session-tab-views-v1")
      localStorage.setItem("opencode-session-previews-v1", JSON.stringify({ "/same": { mode: "chat", targetUrl: "https://example.com/legacy" } }))
    })
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(async () => {
      const set = Storage.prototype.setItem
      Storage.prototype.setItem = function(key, value) {
        if (key === "opencode-session-tab-views-v1") throw new DOMException("Synthetic quota", "QuotaExceededError")
        return set.call(this, key, value)
      }
      await (window as any).fixture.restore("same", "web-a")
    })
    assert.notEqual(await page.evaluate(() => localStorage.getItem("opencode-session-previews-v1")), "{}",
      "a rejected occurrence write retains the legacy migration source")
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    const restored = await page.evaluate(() => (window as any).fixture.restore("same", "web-a"))
    assert.equal(restored.targetUrl, "https://example.com/legacy")
    assert.equal(await page.evaluate(() => localStorage.getItem("opencode-session-previews-v1")), "{}")
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.evaluate(() => (window as any).fixture.saved("same").targetUrl), "https://example.com/legacy")
    assert.equal(await page.evaluate(() => (window as any).fixture.created()), 0)
  } finally { await page.close() }
})

const viewCases = [
  { web: false, close: false }, { web: false, close: false, tauri: true }, { web: false, close: true },
  ...[false, true].flatMap(tauri => [
    { web: false, close: false, tauri, refusedDeletes: 2 },
    { web: false, close: false, tauri, refusedDeletes: 2, stalledInventory: true },
    { web: false, close: false, tauri, refusedDeletes: 1, heldRelease: true },
    { web: false, close: false, tauri, duplicateSidecars: true },
  ]),
  { web: false, close: false, reloadDuringQuit: true },
  { web: false, close: false, tauri: true, reloadDuringQuit: true },
  { web: false, close: false, reloadDuringQuit: true, earlyRelease: true },
  { web: false, close: false, tauri: true, reloadDuringQuit: true, earlyRelease: true },
  { web: true, close: false }, { web: true, close: false, unsupportedDiscard: true },
  { web: true, close: true, late: true }, { web: true, close: false, discard: true },
  { web: true, close: false, delayedCopy: true },
]
for (const { web, close, late, unsupportedDiscard, discard, tauri, delayedCopy, reloadDuringQuit, earlyRelease,
  refusedDeletes = 0, heldRelease, stalledInventory, duplicateSidecars } of viewCases) test(`${web ? "browser-session" : "native"} production capture/restore binds duplicate UUIDs after ${close ? "closure" : "reorder"} (${late ? "late DELETE" : discard ? "discard" : delayedCopy ? "delayed copy" : unsupportedDiscard ? "no discard signal" : tauri ? "Tauri navigation" : "navigation"}${reloadDuringQuit ? ", reload during quit" : ""}${earlyRelease ? ", release before tabs attach" : ""}${refusedDeletes ? `, ${refusedDeletes} refused DELETEs${heldRelease ? " with one still pending at cancel" : ""}` : ""}${stalledInventory ? ", stalled recovery inventory" : ""}${duplicateSidecars ? ", duplicate SideCars" : ""})`, async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const restoredDocument = (candidate: Page) => candidate.locator('[data-restoring="false"]').waitFor({ timeout: 60_000 })
  const errors: string[] = [], loads: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await context.addInitScript(({ web, unsupportedDiscard, discard, tauri, late }) => {
    if (location.search === "?other" || location.search === "?parked") return
    const w = window as any
    w.__name = (value: unknown) => value
    w.__CODENOMAD_RUNTIME_HOST__ = web ? "web" : tauri ? "tauri" : "electron"; w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    w.EventSource = class extends EventTarget { close() {} }
    const boot = Number(sessionStorage.getItem("boot") ?? 0) + 1
    sessionStorage.setItem("boot", String(boot)); w.boot = boot
    const initial = { version: 1, revision: 1, savedAt: 1, layout: {
      "mission-project-HhdJiAYMjxA": JSON.stringify({ selected: "legacy-mission" }),
      "opencode-session-previews-v1": JSON.stringify(Object.fromEntries(["one", "two"].map(id =>
        [JSON.stringify(["/same", id]), { mode: "chat", targetUrl: `https://example.com/${id}` }]))),
    }, session: { activeTabIndex: 0,
      tabs: [0, 1].map(occurrence => ({ kind: "workspace", folder: "/same", occurrence, workspaceId: `web-${occurrence}`,
        activeSessionId: "same", activeParentSessionId: "same", drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} })) } }
    if (web) {
      if (unsupportedDiscard || discard || late && boot > 1) {
        Object.defineProperty(document, "wasDiscarded", { value: unsupportedDiscard ? undefined : true })
      }
      if (boot === 1) {
        for (const [key, value] of Object.entries(initial.layout)) localStorage.setItem(key, value)
        sessionStorage.setItem("codenomad.client-state.v1", JSON.stringify(initial))
      }
      if (discard && boot === 1) window.addEventListener("pagehide", event => {
        if (!event.persisted) event.stopImmediatePropagation()
      }, { capture: true })
    } else if (tauri) {
      const callbacks = new Map(), events = new Map(), acknowledgements: number[] = []
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "local-test" }, currentWebview: { label: "local-test" } },
        transformCallback: (callback: Function) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id },
        invoke: async (command: string, args: any) => {
          if (command === "plugin:event|listen") {
            if (args.event.startsWith("client-state:flush-") && args.target.label !== "local-test") throw new Error("wrong webview target")
            events.set(args.event, args.handler)
            return args.handler
          }
          if (command === "client_state_renderer_flushed") acknowledgements.push(args.generation)
          if (command === "client_state_load") return w.electronAPI.loadClientState()
          if (command === "client_state_save") return w.electronAPI.saveClientState("", args.snapshot)
          return true
        },
      }
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
      w.emitFlush = (cancelled: boolean, generation: number, prepareGeneration?: number) =>
        callbacks.get(events.get(`client-state:flush-${cancelled ? "cancelled" : "requested"}`))?.({
          payload: { generation, prepareGeneration },
        })
      w.acknowledgements = acknowledgements
    }
    if (!web) w.electronAPI = {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: JSON.parse(sessionStorage.getItem("snapshot") ?? "null") ?? initial }),
      saveClientState: async (_token: string, snapshot: unknown) => { sessionStorage.setItem("snapshot", JSON.stringify(snapshot)); return true },
    }
  }, { web, unsupportedDiscard, discard, tauri, late })
  let sequence = 0
  let inventory = ["web-0", "web-1", "other-window"]
  const restorePosts = Promise.withResolvers<void>()
  let holdRestorePosts = false
  let holdNativeRelease = false
  const finishNativeRelease = Promise.withResolvers<void>()
  const heldDelete = Promise.withResolvers<void>()
  const finishDelete = Promise.withResolvers<void>()
  const explicitDeleteCompleted = Promise.withResolvers<boolean>()
  let sourceIds: string[] = []
  let quitIds: string[] = []
  let recoveryReadStarted = false
  const recoveryRead = Promise.withResolvers<void>()
  const recoveryReadAborted = Promise.withResolvers<boolean>()
  const finishRecoveryRead = Promise.withResolvers<void>()
  const deletes: string[] = []
  const mock = (method: string, path: string, input: any) => {
    let body: any = {}
    if (path === "/api/workspaces") {
      if (method === "POST") {
        body = { id: `uuid-${++sequence}`, path: input.path, status: "ready", port: 1234, proxyPath: `/workspaces/uuid-${sequence}/instance`,
          binaryId: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), requestId: input.requestId, temporary: true }
        inventory.push(body.id)
      } else body = inventory.map(id => ({ id, path: "/same", status: "ready", port: 1234, proxyPath: `/workspaces/${id}/instance`,
        binaryId: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), temporary: id !== "other-window" }))
    } else if (path.startsWith("/api/workspaces/") && method === "DELETE") {
      const id = path.split("/").at(-1)!
      if (!late || id !== sourceIds[1]) inventory = inventory.filter(candidate => candidate !== id)
      return undefined
    } else if (path === "/api/sidecars") body = { sidecars: [{ id: "demo", name: "Demo", status: "running" }] }
    else if (path === "/api/previews") {
      loads.push(input.url)
      body = { sessionId: input.sessionId, targetUrl: input.url, token: "preview", proxyUrl: input.url, createdAt: new Date().toISOString() }
    } else if (path.endsWith("/worktrees")) body = { isGitRepo: true, worktrees: [{ slug: "root", directory: "/same", kind: "root" }] }
    else if (path.endsWith("/session") || /\/session\/same$/.test(path)) {
      const row = { id: "same", projectID: "fixture", title: "Same session", location: { directory: "/same" }, time: { created: 1, updated: 1 },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
      body = path.endsWith("/session") ? { data: [row], cursor: {} } : row
    } else if (/\/(?:agent|provider|command|model|permission|form|shell)$/.test(path)) body = { data: [] }
    return body
  }
  // Page teardown detaches Playwright's route interception before keepalive's
  // transport completes. Observe delivery at the HTTP listener instead.
  const server = createServer(async (req, res) => {
    const target = new URL(req.url!, url)
    if (target.search === "?parked") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>")
    if (!/^\/(?:api|workspaces)\//.test(target.pathname)) {
      const upstream = forwardRequest(target, incoming => {
        res.writeHead(incoming.statusCode!, incoming.headers)
        incoming.pipe(res)
      })
      upstream.on("error", () => res.writeHead(502).end())
      upstream.end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.method === "DELETE" && target.pathname.startsWith("/api/workspaces/")) {
      const id = target.pathname.split("/").at(-1)!
      deletes.push(id)
      const quitIndex = quitIds.indexOf(id)
      if (quitIndex >= 0 && quitIndex < refusedDeletes) {
        if (heldRelease) await finishNativeRelease.promise
        return res.writeHead(503).end()
      }
      const explicit = late && id === sourceIds[0]
      if (explicit || delayedCopy && sourceIds.includes(id)) {
        if (explicit) res.on("close", () => explicitDeleteCompleted.resolve(res.writableFinished))
        heldDelete.resolve()
        await finishDelete.promise
        if (res.destroyed) return
      }
    }
    if (stalledInventory && quitIds.length && req.method === "GET" && target.pathname === "/api/workspaces" && !recoveryReadStarted) {
      recoveryReadStarted = true
      res.on("close", () => recoveryReadAborted.resolve(!res.writableFinished))
      recoveryRead.resolve()
      await finishRecoveryRead.promise
      if (res.destroyed) return
    }
    const body = mock(req.method!, target.pathname, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined)
    if (holdRestorePosts && req.method === "POST" && target.pathname === "/api/workspaces") await restorePosts.promise
    if (holdNativeRelease && req.method === "DELETE") await finishNativeRelease.promise
    if (body === undefined) res.writeHead(204).end()
    else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const fixtureUrl = `http://127.0.0.1:${address.port}${new URL(url).pathname}`
  try {
    const other = web && !close && !discard && !delayedCopy ? await context.newPage() : undefined
    if (other) {
      await other.addInitScript(() => {
        const w = window as any
        w.__name = (value: unknown) => value
        w.__CODENOMAD_RUNTIME_HOST__ = "web"; w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
        w.EventSource = class extends EventTarget { close() {} }
        Object.defineProperty(document, "wasDiscarded", { value: true })
        sessionStorage.setItem("codenomad.client-state.v1", JSON.stringify({ version: 1, revision: 1, savedAt: 1,
          layout: {}, session: { activeTabIndex: 0, tabs: [{ kind: "workspace", workspaceId: "other-window", folder: "/same" }] } }))
      })
      await other.goto(`${fixtureUrl}?other`)
      await restoredDocument(other)
    }
    await page.goto(fixtureUrl)
    await restoredDocument(page)
    await page.waitForFunction(() => (window as any).tabViews.ids().length === 2)
    const ids = await page.evaluate(() => (window as any).tabViews.ids()) as string[]
    sourceIds = ids
    assert.equal(ids.includes("web-0"), Boolean(discard), "only a same-tab discard reclaims exact records")
    assert.deepEqual(await page.evaluate(ids => ids.map((id: string) => (window as any).tabViews.view(id).missions?.selected), ids),
      ["legacy-mission", undefined], "folder Mission selection adopts into the first descriptor only")
    const legacyUrls = await page.evaluate(async id => {
      const f = (window as any).tabViews
      return [(await f.restore("one", id)).targetUrl, (await f.restore("two", id)).targetUrl]
    }, ids[0])
    assert.deepEqual(legacyUrls, ["https://example.com/one", "https://example.com/two"], "descriptor migration restores both sessions sequentially in one occurrence")
    assert.deepEqual(await page.evaluate(id => Object.keys((window as any).tabViews.view(id).previews), ids[0]), ["one", "two"])
    await page.evaluate(async ([a, b]) => {
      const f = (window as any).tabViews
      await f.open("same", "https://example.com/a", a); f.files(a)
      f.mission(b)
      f.reorder(b, a)
      f.writeDraft(b, "restored draft")
    }, ids)
    if (close) await page.evaluate(id => (window as any).tabViews.close(id), ids[0])
    if (web) {
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }))
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))
      })
      await page.waitForFunction(close => {
        const tabs = JSON.parse(sessionStorage.getItem("codenomad.client-state.v1")!).session.tabs
        return tabs.length === (close ? 1 : 2) && tabs[0].viewState?.missions?.reader?.missionId === "debug"
      }, close)
      assert.deepEqual(deletes, close ? [ids[0]] : [], "entering and leaving bfcache does not delete any records")
      assert.equal(await page.evaluate(() => sessionStorage.getItem("codenomad.client-state.records-released")), null)
    } else if (close) {
      await page.evaluate(() => window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__!("prepare"))
      assert.ok(ids.slice(close ? 1 : 0).every(id => !deletes.includes(id)), "snapshot preparation sends no release")
      holdNativeRelease = true
      await page.evaluate(() => window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__!("release"))
      assert.ok(ids.slice(close ? 1 : 0).every(id => deletes.includes(id)), "approved native release dispatches without waiting indefinitely for DELETE")
      assert.ok(inventory.includes("other-window"))
      finishNativeRelease.resolve()
    } else await page.evaluate(() => window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__!())
    const captured = await page.evaluate(web => JSON.parse(sessionStorage.getItem(web ? "codenomad.client-state.v1" : "snapshot")!).session.tabs, web)
    assert.equal(captured.length, close ? 1 : 2)
    assert.equal(captured[0].viewState.missions.reader.kind, "playbook")
    assert.equal(captured[0].viewState.missions.reader.missionId, "debug")
    if (!close) assert.deepEqual(captured[1].viewState.previews.same, { mode: "preview" })
    assert.equal(await page.evaluate(() => (window as any).tabViews.saved("same").targetUrl), "https://example.com/a")
    if (other || delayedCopy) {
      const opened = page.waitForEvent("popup")
      await page.evaluate(delayed => { window.open(delayed ? "?parked" : location.href) }, delayedCopy)
      const copy = await opened
      if (delayedCopy) {
        assert.equal(await copy.evaluate(() => sessionStorage.getItem("codenomad.client-state.records-released")), null)
        await page.goto(`${fixtureUrl}?parked`)
        await heldDelete.promise
        assert.ok(ids.every(id => inventory.includes(id)), "source DELETEs are pending while the copy starts")
        await copy.goto(fixtureUrl)
      }
      await restoredDocument(copy)
      const copied = await copy.evaluate(() => {
        const f = (window as any).tabViews
        return f.ids().map((id: string) => ({ id, draft: f.draft(id), view: f.view(id) }))
      })
      assert.equal(copied.length, 2)
      assert.ok(copied.every((v: any) => inventory.includes(v.id) && !ids.includes(v.id)), "a duplicated page owns different records")
      assert.equal(copied[0].draft, "restored draft")
      assert.deepEqual(copied.map((v: any) => v.view), captured.map((v: any) => v.viewState))
      if (delayedCopy) {
        finishDelete.resolve()
        await copy.waitForFunction(async (ids: string[]) => {
          const rows = await (await fetch("/api/workspaces")).json()
          return ids.every(id => !rows.some((row: any) => row.id === id))
        }, ids)
        assert.ok(copied.every((row: any) => inventory.includes(row.id)), "source DELETEs cannot remove the copy's records")
        return
      }
      const closed = copy.waitForEvent("close")
      await copy.close({ runBeforeUnload: true })
      await closed
      await page.waitForFunction(async (ids: string[]) => {
        const rows = await (await fetch("/api/workspaces")).json()
        return ids.every(id => !rows.some((row: any) => row.id === id))
      }, copied.map((v: any) => v.id))
      assert.ok(ids.every(id => inventory.includes(id)), "closing a popup with copied sessionStorage keeps the opener's records")
    }
    const count = loads.length
    if (late) await heldDelete.promise
    await page.reload(); await restoredDocument(page)
    if (late) {
      finishDelete.resolve()
      assert.equal(await explicitDeleteCompleted.promise, true, "immediate reload does not cancel the detached tab's DELETE")
      assert.ok(!inventory.includes(ids[0]))
    }
    assert.equal(deletes.includes(ids[1]), !discard, "reload sends the keepalive DELETE unless pagehide was skipped")
    const restored = await page.evaluate(() => (window as any).tabViews.ids().map((id: string) => ({ id, view: (window as any).tabViews.view(id) })))
    assert.equal(restored.length, captured.length)
    if (discard) {
      assert.deepEqual(restored.map((row: any) => row.id), [...ids].reverse())
      assert.equal(sequence, 0)
    } else assert.ok(restored.every((v: any) => !ids.includes(v.id)), "backend recreation changes every instance UUID")
    if (web) {
      assert.ok(inventory.includes("other-window"), "the other window's same-folder record survives")
      assert.ok(restored.every((v: any) => v.id !== "other-window"))
      assert.equal(await page.evaluate(id => (window as any).tabViews.temporary(id), restored[0].id), true)
      await page.waitForFunction(() => !sessionStorage.getItem("codenomad.client-state.records-released"))
    }
    assert.equal(await page.evaluate(id => (window as any).tabViews.draft(id), restored[0].id), "restored draft")
    assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-session-selection"), "same")
    assert.deepEqual(restored.map((v: any) => v.view), captured.map((v: any) => v.viewState))
    assert.equal(loads.length, count, "restoration allocates zero preview records and loads zero saved pages")
    if (!web && !close) {
      const sidecars = page.locator('[role="tab"][data-tab-kind="sidecar"]')
      const sidecarOrder = () => sidecars.evaluateAll(tabs => tabs.map(tab => tab.getAttribute("data-app-tab-id")))
      const active = () => page.evaluate(() => (window as any).tabViews.active())
      let beforeSidecars: string[] = []
      if (duplicateSidecars) {
        beforeSidecars = await page.evaluate(() => (window as any).tabViews.openDuplicateSidecars())
        assert.deepEqual(await sidecarOrder(), beforeSidecars)
        assert.equal(await active(), beforeSidecars[1], "select the second SideCar before quit")
      }
      const flush = (generation: number, phase: "prepare" | "release" | "cancel") => page.evaluate(async ({ phase, generation, tauri }) => {
        if (tauri) (window as any).emitFlush(phase === "cancel", generation, phase === "release" ? 1 : undefined)
        else await window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__!(phase)
      }, { generation, phase, tauri })
      await flush(1, "prepare")
      if (tauri) await page.waitForFunction(() => (window as any).acknowledgements.includes(1))
      if (reloadDuringQuit) {
        holdRestorePosts = Boolean(earlyRelease)
        const starting = earlyRelease ? page.waitForRequest(request =>
          request.method() === "POST" && new URL(request.url()).pathname === "/api/workspaces", { timeout: 15_000 }) : undefined
        await page.reload()
        if (starting) await starting
        else await restoredDocument(page)
        assert.equal(await page.evaluate(() => document.documentElement.inert), false, "the replacement did not receive prepare")
        if (!earlyRelease) await page.evaluate(() => window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__!())
      }
      const released = await page.evaluate(() => (window as any).tabViews.ids()) as string[]
      quitIds = released
      assert.equal(released.length, earlyRelease ? 0 : 2)
      if (earlyRelease) {
        const navigatedIds = restored.map(({ id }: { id: string }) => id)
        await page.waitForFunction(async ids => {
          const rows = await (await fetch("/api/workspaces")).json()
          return ids.every((id: string) => !rows.some((row: { id: string }) => row.id === id))
        }, navigatedIds)
      }
      const deletesBeforeRelease = [...deletes]
      await flush(2, "release")
      if (tauri) await page.waitForFunction(() => (window as any).acknowledgements.includes(2))
      assert.ok(released.every(id => deletes.includes(id)))
      if (earlyRelease) assert.deepEqual(deletes, deletesBeforeRelease, "release cannot DELETE records before tabs attach")
      assert.equal(await page.evaluate(() => document.documentElement.inert), true, "input stays locked through release")
      if (tauri) {
        await flush(2, "cancel")
        assert.equal(await page.evaluate(() => document.documentElement.inert), true, "the release ACK generation cannot cancel prepare")
      }
      if (!earlyRelease && !refusedDeletes && !duplicateSidecars) {
        await page.evaluate(ids => { for (const id of ids) (window as any).tabViews.remove(id) }, released)
        await page.waitForFunction(() => (window as any).tabViews.ids().length === 0)
        await page.evaluate(() => window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__!())
        assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("snapshot")!).session.tabs
          .map((tab: any) => tab.workspaceId)), released, "a navigation flush during release cannot commit the empty renderer")
      }
      if (stalledInventory) {
        const now = Date.now()
        await page.clock.install({ time: now })
        await page.clock.pauseAt(now + 1_000)
      }
      await flush(1, "cancel")
      restorePosts.resolve()
      assert.equal(await page.evaluate(() => document.documentElement.inert), false, "refused quit unlocks input")
      if (heldRelease) {
        assert.ok(!(await page.evaluate(() => (window as any).tabViews.ids())).includes(quitIds[0]),
          "do not reuse a record with DELETE still in flight")
        finishNativeRelease.resolve()
      }
      if (stalledInventory) {
        await recoveryRead.promise
        assert.equal(await page.locator('[data-tab-kind="remote-restore"]').count(), 2)
        await page.evaluate(() => { void (window as any).tabViews.retry() })
        assert.equal(await page.evaluate(() => (window as any).tabViews.refresh()), true)
        await page.clock.fastForward(15_001)
        await page.clock.resume()
      }
      await restoredDocument(page)
      await page.waitForFunction(() => (window as any).tabViews.ids().length === 2, undefined, { timeout: 5_000 })
      if (stalledInventory) assert.equal(await recoveryReadAborted.promise, true)
      const recovered = await page.evaluate(() => (window as any).tabViews.ids().map((id: string) => ({ id, view: (window as any).tabViews.view(id) })))
      const recoveredIds = recovered.map((row: any) => row.id)
      const reused = stalledInventory ? 0 : refusedDeletes
      assert.deepEqual(recoveredIds.slice(0, reused), released.slice(0, reused), "reuse only confirmed surviving occurrences")
      assert.ok(recoveredIds.slice(reused).every((id: string) => !restored.some((previous: any) => previous.id === id) && !released.includes(id)))
      if (refusedDeletes) {
        assert.equal(new Set(recoveredIds).size, 2)
        assert.deepEqual(inventory.filter(id => id.startsWith("uuid-")).sort(),
          [...recoveredIds, ...stalledInventory ? released : []].sort(), "leave unconfirmed records alone")
      }
      assert.deepEqual(recovered.map((row: any) => row.view), restored.map((row: any) => row.view))
      await page.waitForFunction(id => (window as any).tabViews.draft(id) === "restored draft", recovered[0].id)
      if (duplicateSidecars) {
        assert.deepEqual(await sidecarOrder(), beforeSidecars)
        assert.equal(await active(), beforeSidecars[1], "keep the selected SideCar occurrence")
      } else await page.locator('[role="tab"][aria-selected="true"][data-session-selection="same"]').waitFor()
      await page.waitForFunction(ids => JSON.parse(sessionStorage.getItem("snapshot")!).session.tabs
        .filter((tab: any) => tab.kind === "workspace").map((tab: any) => tab.workspaceId).join() === ids.join(), recoveredIds)
    }
    assert.deepEqual(errors, [])
    if (late) {
      assert.ok(inventory.includes(ids[1]), "the old record was listed when the replacement restored")
      inventory = inventory.filter(id => id !== ids[1])
      await page.evaluate(async id => {
        const f = (window as any).tabViews
        f.remove(id)
        await f.refresh()
      }, ids[1])
      assert.deepEqual(await page.evaluate(() => (window as any).tabViews.ids()), restored.map((row: any) => row.id))
      assert.equal(sequence, 3, "a released snapshot creates fresh records even with a discard signal")
    }
    if (other) {
      await page.evaluate(() => (window as any).tabViews.disableRestore())
      const closed = page.waitForEvent("close")
      await page.close({ runBeforeUnload: true })
      await closed
      await other.waitForFunction(async (ids: string[]) => {
        const rows = await (await fetch("/api/workspaces")).json()
        return ids.every(id => !rows.some((row: any) => row.id === id))
      }, restored.map((v: any) => v.id))
      const noticeCounts = await other.evaluate((ids: string[]) => {
        const before = (window as any).tabViews.noticeCount()
        for (const id of ids) (window as any).tabViews.remove(id)
        return [before, (window as any).tabViews.noticeCount()]
      }, restored.map((v: any) => v.id))
      assert.equal(noticeCounts[0], noticeCounts[1], "no closed-elsewhere notice for records this page never opened")
      assert.deepEqual(await other.evaluate(() => (window as any).tabViews.ids()), ["other-window"])
    }
  } finally {
    restorePosts.resolve()
    finishDelete.resolve()
    finishNativeRelease.resolve()
    finishRecoveryRead.resolve()
    await context.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
