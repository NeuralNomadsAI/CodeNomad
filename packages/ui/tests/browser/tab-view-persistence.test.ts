import assert from "node:assert/strict"
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

for (const remote of [false, true]) test(`${remote ? "remote" : "web"} previews persist through the production lifecycle and adopt legacy URLs`, async () => {
  const page = await browser.newPage()
  try {
    await page.addInitScript(({ remote }) => {
      const w = window as any
      w.__name = (value: unknown) => value
      w.__CODENOMAD_RUNTIME_HOST__ = "web"
      w.__CODENOMAD_WINDOW_CONTEXT__ = remote ? "remote" : "local"
      w.EventSource = class extends EventTarget { close() {} }
    }, { remote })
    await page.route("**/api/**", route => route.fulfill({ json: [] }))
    await page.goto(webUrl); await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(async () => {
      const f = (window as any).fixture
      const a = await f.open("same", "https://example.com/a", "web-a")
      f.history(a.storageKey, { urls: ["https://example.com/a", "https://example.com/next"], index: 1 })
      f.viewport(a.storageKey, "mobile")
      await f.open("same", "https://example.com/b", "web-b")
      f.hide("same", "web-b")
      await f.flush()
    })
    assert.equal(await page.evaluate(() => (window as any).fixture.state()), null, "non-native clients never acquire a native snapshot")
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    const views = await page.evaluate(() => ["web-a", "web-b"].map(id => (window as any).fixture.view(id).previews.same))
    assert.deepEqual(views.map(v => [v.targetUrl, v.mode]), [["https://example.com/next", "preview"], ["https://example.com/b", "chat"]])
    assert.deepEqual(views[0].history, { urls: ["https://example.com/a", "https://example.com/next"], index: 1 })
    assert.equal(views[0].viewport, "mobile")
    assert.equal(await page.evaluate(() => (window as any).fixture.created()), 0)
    await page.evaluate(async () => { await (window as any).fixture.restore("same", "web-a"); await (window as any).fixture.flush() })
    assert.equal(await page.evaluate(() => (window as any).fixture.preview("same", "web-a").targetUrl), "https://example.com/next")
    await page.evaluate(() => (window as any).fixture.close("web-a"))
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.evaluate(() => (window as any).fixture.view("web-a").previews.same.targetUrl), "https://example.com/b",
      "the surviving duplicate retains its view when backend occurrence ranks compact")
    assert.equal(await page.evaluate(() => (window as any).fixture.view("web-b").previews), undefined)
    await page.evaluate(() => {
      localStorage.removeItem("opencode-session-tab-views-v1")
      localStorage.setItem("opencode-session-previews-v1", JSON.stringify({ "/same": { mode: "chat", targetUrl: "https://example.com/legacy" } }))
    })
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    const restored = await page.evaluate(() => (window as any).fixture.restore("same", "web-a"))
    assert.equal(restored.targetUrl, "https://example.com/legacy")
    assert.equal(await page.evaluate(() => localStorage.getItem("opencode-session-previews-v1")), "{}")
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.evaluate(() => (window as any).fixture.view("web-a").previews.same.targetUrl), "https://example.com/legacy")
    assert.equal(await page.evaluate(() => (window as any).fixture.created()), 0)
  } finally { await page.close() }
})

for (const close of [false, true]) test(`production capture/restore binds recreated duplicate UUIDs after ${close ? "closure" : "reorder"}, without loading saved pages`, async () => {
  const page = await browser.newPage()
  const errors: string[] = [], loads: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => {
    const w = window as any
    w.__name = (value: unknown) => value
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"; w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    w.EventSource = class extends EventTarget { close() {} }
    const boot = Number(sessionStorage.getItem("boot") ?? 0) + 1
    sessionStorage.setItem("boot", String(boot)); w.boot = boot
    const initial = { version: 1, revision: 1, savedAt: 1, layout: {}, session: { activeTabIndex: 0,
      tabs: [0, 1].map(occurrence => ({ kind: "workspace", folder: "/same", occurrence,
        activeSessionId: "same", activeParentSessionId: "same", drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} })) } }
    w.electronAPI = {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: JSON.parse(sessionStorage.getItem("snapshot") ?? "null") ?? initial }),
      saveClientState: async (_token: string, snapshot: unknown) => { sessionStorage.setItem("snapshot", JSON.stringify(snapshot)); return true },
    }
  })
  let sequence = 0
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const path = new URL(route.request().url()).pathname
    let body: any = {}
    if (path === "/api/workspaces") {
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON()
        body = { id: `uuid-${++sequence}`, path: input.path, status: "ready", port: 1234, proxyPath: `/workspaces/uuid-${sequence}/instance`,
          binaryId: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), requestId: input.requestId }
      } else body = []
    } else if (path === "/api/previews") {
      const input = route.request().postDataJSON()
      loads.push(input.url)
      body = { sessionId: input.sessionId, targetUrl: input.url, token: "preview", proxyUrl: input.url, createdAt: new Date().toISOString() }
    } else if (path.endsWith("/worktrees")) body = { isGitRepo: true, worktrees: [{ slug: "root", directory: "/same", kind: "root" }] }
    else if (path.endsWith("/session") || /\/session\/same$/.test(path)) {
      const row = { id: "same", projectID: "fixture", title: "Same session", location: { directory: "/same" }, time: { created: 1, updated: 1 },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
      body = path.endsWith("/session") ? { data: [row], cursor: {} } : row
    } else if (/\/(?:agent|provider|command|model|permission|form|shell)$/.test(path)) body = { data: [] }
    await route.fulfill({ json: body })
  })
  try {
    await page.goto(url)
    await page.locator('[data-restoring="false"]').waitFor()
    await page.waitForFunction(() => (window as any).tabViews.ids().length === 2)
    const ids = await page.evaluate(() => (window as any).tabViews.ids()) as string[]
    await page.evaluate(async ([a, b]) => {
      const f = (window as any).tabViews
      await f.open("same", "https://example.com/a", a); f.files(a)
      f.mission(b)
      f.reorder(b, a)
    }, ids)
    if (close) await page.evaluate(id => (window as any).tabViews.close(id), ids[0])
    await page.evaluate(() => (window as any).__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__())
    const captured = await page.evaluate(() => JSON.parse(sessionStorage.getItem("snapshot")!).session.tabs)
    assert.equal(captured.length, close ? 1 : 2)
    assert.equal(captured[0].viewState.missions.reader.kind, "playbook")
    assert.equal(captured[0].viewState.missions.reader.missionId, "debug")
    if (!close) assert.equal(captured[1].viewState.previews.same.targetUrl, "https://example.com/a")
    const count = loads.length
    await page.reload(); await page.locator('[data-restoring="false"]').waitFor()
    const restored = await page.evaluate(() => (window as any).tabViews.ids().map((id: string) => ({ id, view: (window as any).tabViews.view(id) })))
    assert.equal(restored.length, captured.length)
    assert.ok(restored.every((v: any) => !ids.includes(v.id)), "backend recreation changes every instance UUID")
    assert.deepEqual(restored.map((v: any) => v.view), captured.map((v: any) => v.viewState))
    assert.equal(loads.length, count, "restoration allocates zero preview records and loads zero saved pages")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
