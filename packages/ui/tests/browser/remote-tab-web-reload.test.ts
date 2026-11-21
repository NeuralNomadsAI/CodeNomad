import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"
import { RELAY_AUTHORITY_HEADER } from "../../../server/src/codenomad-servers/relay-authority"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "remote-tab-web-reload", routes: [
    { path: "/fixture", html: '<html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/remote-tab-restore.tsx"></script></body></html>' },
  ] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const offline of [false, true]) test(`web reload recreates backend-owned records and keeps placeholders (offline=${offline})`, async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(60_000)
  const errors: string[] = [], creates: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await context.addInitScript(() => {
    ;(window as any).__name = new Function("value", "return value")
    Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "web", __CODENOMAD_WINDOW_CONTEXT__: "remote" })
    window.EventSource = class extends EventTarget { close() {} } as any
    if (sessionStorage.getItem("codenomad.client-state.v1")) return
    Object.defineProperty(document, "wasDiscarded", { value: true })
    sessionStorage.setItem("codenomad.client-state.v1", JSON.stringify({
      version: 1, revision: 1, savedAt: 1, layout: {}, session: { activeTabIndex: 1, tabs: [
        { workspaceId: "survivor", occurrence: 0 },
        { workspaceId: "a~survivor", backendId: "a", serverId: "a", occurrence: 1 },
        { workspaceId: "b~gone", backendId: "b", serverId: "b", occurrence: 0 },
      ].map((owner, index) => ({ kind: "workspace", folder: "/same", ...owner,
        drafts: { __no_session_draft__: `owner-${index}` }, attachments: {},
        scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} })) },
    }))
  })
  let healthy = !offline
  await context.route(url => /^\/(?:api|workspaces)\//.test(url.pathname), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    const backend = pathname.match(/^\/api\/backends\/([ab])\//)?.[1]
    const path = backend ? pathname.slice(`/api/backends/${backend}`.length) : pathname
    let body: any = {}
    if (path.startsWith("/api/storage/")) {
      body = backend ? {} : path.endsWith("/config/ui") ? { settings: { multiBackend: true } }
        : path.endsWith("/state/ui") ? { remoteServers: ["a", "b"].map(id => ({
          id, name: `Server ${id}`, baseUrl: `https://${id}.test`, skipTlsVerify: false, createdAt: "", updatedAt: "",
        })) } : {}
    } else if (path === "/api/meta") {
      if (backend === "a" && !healthy) return route.fulfill({ status: 503, json: { error: "offline" } })
      body = { apiContract: CODENOMAD_API_CONTRACT, serverId: backend ?? "local" }
    } else if (path === "/api/workspaces") {
      if (request.method() === "POST") creates.push(`${backend ?? "local"}:${request.postData()}`)
      const id = request.method() === "POST" && creates.length > 1 ? `fresh-${creates.length}` : "survivor"
      const descriptor = {
        id, path: "/same", status: "ready", port: 1234,
        proxyPath: `/workspaces/${id}/instance`, binaryId: "fixture", createdAt: "", updatedAt: "",
      }
      body = request.method() === "POST" ? { ...descriptor, requestId: request.postDataJSON().requestId }
        : backend === "b" ? [] : [descriptor]
    } else if (path.endsWith("/worktrees")) body = { isGitRepo: false, worktrees: [] }
    else if (path.includes("/instance/api/")) body = { data: [], cursor: {} }
    await route.fulfill({ json: body, headers: backend && path === "/api/meta" ? { [RELAY_AUTHORITY_HEADER]: "x".repeat(43) } : undefined })
  })
  try {
    await page.goto(url)
    await page.locator('[data-restoring="false"]').waitFor()
    if (offline) {
      const parked = await page.evaluate(() => (window as any).restoreFixture.tabs())
      assert.equal(parked[1].kind, "remote-restore")
      assert.equal(parked[1].drafts.__no_session_draft__, "owner-1")
      healthy = true
      await page.evaluate(() => (window as any).restoreFixture.retry())
    }
    await page.waitForFunction(() => (window as any).restoreFixture.tabs().some((tab: any) => tab.id === "instance:a~survivor"))
    const expected = [
      ["instance:survivor", "instance", "owner-0"],
      ["instance:a~survivor", "instance", "owner-1"],
      ["instance:b~survivor", "instance", "owner-2"],
    ]
    const read = () => page.evaluate(() => (window as any).restoreFixture.tabs().map((tab: any) => [
      tab.kind === "remote-restore" ? tab.kind : tab.id, tab.kind, tab.drafts.__no_session_draft__,
    ]))
    assert.deepEqual(await read(), expected)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })))
    await page.waitForFunction(() => {
      const state = JSON.parse(sessionStorage.getItem("codenomad.client-state.v1")!)
      return state.session.tabs[1].workspaceId === "a~survivor" && state.session.tabs[1].occurrence === 0
    })
    await page.reload()
    await page.locator('[data-restoring="false"]').waitFor()
    const reloaded = await read()
    assert.deepEqual(reloaded.map((row: string[]) => row.slice(1)), expected.map(row => row.slice(1)))
    assert.ok(reloaded.every((row: string[], index: number) => row[0] !== expected[index][0]))
    assert.equal(creates.length, 4, "the first load restores one missing record; reload recreates all three")
    const localId = reloaded[0][0]
    await page.evaluate(id => {
      const fixture = (window as any).restoreFixture
      fixture.close(id)
      fixture.stopped(id)
    }, reloaded[2][0])
    await page.evaluate(() => (window as any).restoreFixture.reopen("local"))
    const local = (await read()).find((tab: string[]) => tab[0] === localId)
    assert.equal(local[2], "owner-0", "local homonym never consumes the closed remote draft")
    await page.evaluate(() => (window as any).restoreFixture.reopen("b"))
    await page.waitForFunction(() => (window as any).restoreFixture.tabs().some((tab: any) =>
      tab.id.startsWith("instance:b~") && tab.drafts.__no_session_draft__ === "owner-2"))
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
