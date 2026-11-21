import assert from "node:assert/strict"
import { createServer, request as forwardRequest } from "node:http"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
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
  { web: false, close: false }, { web: false, close: true },
  { web: true, close: false }, { web: true, close: false, broadcast: true },
  { web: true, close: true, late: "inventory" }, { web: true, close: false, late: "overlap" },
]
for (const { web, close, late, broadcast } of viewCases) test(`${web ? "browser-session" : "native"} production capture/restore binds duplicate UUIDs after ${close ? "closure" : "reorder"} (${late ?? (broadcast ? "broadcast" : "navigation")})`, async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = [], loads: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await context.addInitScript(({ web, broadcast }) => {
    if (location.search === "?other") return
    if (broadcast) Object.defineProperty(navigator, "locks", { value: undefined })
    const w = window as any
    w.__name = (value: unknown) => value
    w.__CODENOMAD_RUNTIME_HOST__ = web ? "web" : "electron"; w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    w.EventSource = class extends EventTarget { close() {} }
    const boot = Number(sessionStorage.getItem("boot") ?? 0) + 1
    sessionStorage.setItem("boot", String(boot)); w.boot = boot
    const initial = { version: 1, revision: 1, savedAt: 1, layout: {
      "mission-project-HhdJiAYMjxA": JSON.stringify({ selected: "legacy-mission" }),
      "opencode-session-previews-v1": JSON.stringify(Object.fromEntries(["one", "two"].map(id =>
        [JSON.stringify(["/same", id]), { mode: "chat", targetUrl: `https://example.com/${id}` }]))),
    }, session: { activeTabIndex: 0,
      tabs: [0, 1].map(occurrence => ({ kind: "workspace", folder: "/same", occurrence, ...(web ? { workspaceId: `web-${occurrence}` } : {}),
        activeSessionId: "same", activeParentSessionId: "same", drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} })) } }
    if (web) {
      if (boot === 1) {
        for (const [key, value] of Object.entries(initial.layout)) localStorage.setItem(key, value)
        sessionStorage.setItem("codenomad.client-state.v1", JSON.stringify(initial))
      }
    } else w.electronAPI = {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: JSON.parse(sessionStorage.getItem("snapshot") ?? "null") ?? initial }),
      saveClientState: async (_token: string, snapshot: unknown) => { sessionStorage.setItem("snapshot", JSON.stringify(snapshot)); return true },
    }
  }, { web, broadcast })
  let sequence = 0
  let inventory = ["web-0", "web-1", "other-window"]
  let beforeCreate: (() => Promise<void>) | undefined
  const deletes: string[] = []
  const mock = (method: string, path: string, input: any) => {
    let body: any = {}
    if (path === "/api/workspaces") {
      if (method === "POST") {
        body = { id: `uuid-${++sequence}`, path: input.path, status: "ready", port: 1234, proxyPath: `/workspaces/uuid-${sequence}/instance`,
          binaryId: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), requestId: input.requestId, temporary: true }
        inventory.push(body.id)
      } else body = web ? inventory.map(id => ({ id, path: "/same", status: "ready", port: 1234, proxyPath: `/workspaces/${id}/instance`,
        binaryId: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), temporary: id !== "other-window" })) : []
    } else if (web && path.startsWith("/api/workspaces/") && method === "DELETE") {
      const id = path.split("/").at(-1)!
      deletes.push(id)
      if (id.startsWith("uuid-") || !close && !late || close && id === "web-0") inventory = inventory.filter(candidate => candidate !== id)
      return undefined
    } else if (path === "/api/previews") {
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
    if (req.method === "POST" && target.pathname === "/api/workspaces") await beforeCreate?.()
    const body = mock(req.method!, target.pathname, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined)
    if (body === undefined) res.writeHead(204).end()
    else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const fixtureUrl = `http://127.0.0.1:${address.port}${new URL(url).pathname}`
  try {
    const other = web && !close && !late ? await context.newPage() : undefined
    if (other) {
      await other.addInitScript(() => {
        const w = window as any
        w.__name = (value: unknown) => value
        w.__CODENOMAD_RUNTIME_HOST__ = "web"; w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
        w.EventSource = class extends EventTarget { close() {} }
        sessionStorage.setItem("codenomad.client-state.v1", JSON.stringify({ version: 1, revision: 1, savedAt: 1,
          layout: {}, session: { activeTabIndex: 0, tabs: [{ kind: "workspace", workspaceId: "other-window", folder: "/same" }] } }))
      })
      await other.goto(`${fixtureUrl}?other`)
      await other.locator('[data-restoring="false"]').waitFor()
    }
    await page.goto(fixtureUrl)
    await page.locator('[data-restoring="false"]').waitFor()
    await page.waitForFunction(() => (window as any).tabViews.ids().length === 2)
    const ids = await page.evaluate(() => (window as any).tabViews.ids()) as string[]
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
      assert.deepEqual(deletes, close ? ["web-0"] : [], "entering and leaving bfcache does not delete any records")
    } else await page.evaluate(() => (window as any).__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__())
    const captured = await page.evaluate(web => JSON.parse(sessionStorage.getItem(web ? "codenomad.client-state.v1" : "snapshot")!).session.tabs, web)
    assert.equal(captured.length, close ? 1 : 2)
    assert.equal(captured[0].viewState.missions.reader.kind, "playbook")
    assert.equal(captured[0].viewState.missions.reader.missionId, "debug")
    if (!close) assert.deepEqual(captured[1].viewState.previews.same, { mode: "preview" })
    assert.equal(await page.evaluate(() => (window as any).tabViews.saved("same").targetUrl), "https://example.com/a")
    if (other) {
      const opened = page.waitForEvent("popup")
      await page.evaluate(() => { window.open(location.href) })
      const copy = await opened
      await copy.locator('[data-restoring="false"]').waitFor()
      const copied = await copy.evaluate(() => {
        const f = (window as any).tabViews
        return f.ids().map((id: string) => ({ id, draft: f.draft(id), view: f.view(id) }))
      })
      assert.equal(copied.length, 2)
      assert.equal(copied[0].draft, "restored draft")
      assert.deepEqual(copied.map((v: any) => v.view), captured.map((v: any) => v.viewState))
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
    await page.reload(); await page.locator('[data-restoring="false"]').waitFor()
    if (web) assert.ok(deletes.includes("web-1"), "reload sends the keepalive DELETE")
    const restored = await page.evaluate(() => (window as any).tabViews.ids().map((id: string) => ({ id, view: (window as any).tabViews.view(id) })))
    assert.equal(restored.length, captured.length)
    if (late) {
      assert.equal(restored[0].id, "web-1", "a dropped DELETE leaves the exact record reusable")
      assert.equal(sequence, 0)
    } else assert.ok(restored.every((v: any) => !ids.includes(v.id)), "backend recreation changes every instance UUID")
    if (web) {
      assert.ok(inventory.includes("other-window"), "the other window's same-folder record survives")
      assert.ok(restored.every((v: any) => v.id !== "other-window"))
      assert.equal(await page.evaluate(id => (window as any).tabViews.temporary(id), restored[0].id), true)
    }
    assert.equal(await page.evaluate(id => (window as any).tabViews.draft(id), restored[0].id), "restored draft")
    assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-session-selection"), "same")
    assert.deepEqual(restored.map((v: any) => v.view), captured.map((v: any) => v.viewState))
    assert.equal(loads.length, count, "restoration allocates zero preview records and loads zero saved pages")
    assert.deepEqual(errors, [])
    if (late) {
      inventory = inventory.filter(id => id !== "web-1")
      if (late === "inventory") await page.evaluate(() => (window as any).tabViews.refresh())
      else {
        const first = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/workspaces")
        const gate = Promise.withResolvers<void>()
        beforeCreate = () => gate.promise
        try {
          await page.evaluate(() => (window as any).tabViews.remove("web-1"))
          await first
          inventory = inventory.filter(id => id !== "web-0")
          await page.evaluate(() => (window as any).tabViews.remove("web-0"))
        } finally { gate.resolve() }
      }
      await page.waitForFunction(() => (window as any).tabViews.ids()[0]?.startsWith("uuid-"))
      if (late === "overlap") await page.waitForFunction(() => (window as any).tabViews.ids().length === 2)
      assert.equal(await page.evaluate(() => {
        const f = (window as any).tabViews
        return f.draft(f.ids()[0])
      }), "restored draft")
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
    await context.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
