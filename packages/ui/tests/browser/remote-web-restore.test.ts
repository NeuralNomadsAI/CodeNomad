import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"
import { RELAY_AUTHORITY_HEADER } from "../../../server/src/codenomad-servers/relay-authority"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "remote-web-restore", routes: [
    { path: "/fixture", html: '<html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/remote-tab-restore.tsx"></script></body></html>' },
  ] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined,
    args: ["--host-resolver-rules=MAP 192.0.2.1 127.0.0.1", "--no-proxy-server"] })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const mode of ["reuse", "offline", "missing", "rate-limited", "uncertain"]) test(`web mobile HTTP: ${mode}, A/B identities and explicit recovery`, { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36" })
  let page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(60_000)
  const errors: string[] = [], creates: string[] = [], requestIds: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await context.addInitScript(() => {
    ;(window as any).__name = new Function("value", "return value")
    Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "web", __CODENOMAD_WINDOW_CONTEXT__: "remote" })
    Object.defineProperty(crypto, "randomUUID", { value: undefined })
    Object.defineProperty(navigator, "clipboard", { value: undefined })
    window.EventSource = class extends EventTarget { close() {} } as any
    if (!sessionStorage.getItem("codenomad.client-state.v1")) {
      sessionStorage.setItem("codenomad.client-state.v1", JSON.stringify({
        version: 1, revision: 1, savedAt: 1, layout: {}, session: { activeTabIndex: 1, tabs: ["a", "b"].map((backendId, index) => ({
          kind: "workspace", folder: "/same", backendId, workspaceId: `${backendId}~same`, occurrence: 0,
          drafts: { __no_session_draft__: `draft-${backendId}` }, attachments: {}, scrollSnapshots: {},
          unseenIdleSince: {}, generationRecovery: {}, viewState: { version: 1, rightPanelTab: index ? "files" : "status" },
        })) },
      }))
    }
  })
  let healthy = mode !== "offline"
  const inventories = new Map(["a", "b"].map(id => [id, !["reuse", "offline"].includes(mode) && id === "b" ? [] : [
    descriptor("sibling", "/same"), descriptor("same", "/same"),
  ]]))
  await context.route(/\/(?:api|workspaces)\//, async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    const owner = /^\/api\/backends\/([ab])/.exec(pathname)?.[1]
    const path = owner ? pathname.slice(`/api/backends/${owner}`.length) : pathname
    let body: any = {}
    if (path.startsWith("/api/storage/")) body = owner ? {} : path.endsWith("/config/ui") ? { settings: { multiBackend: true } }
      : path.endsWith("/state/ui") ? { remoteServers: ["a", "b"].map(id => ({
        id, name: `Server ${id.toUpperCase()}`, baseUrl: `https://${id}.test`, skipTlsVerify: false, createdAt: "", updatedAt: "",
      })) } : {}
    else if (path === "/api/meta") {
      if (owner === "b" && !healthy) return route.fulfill({ status: 503, json: { error: "offline" } })
      body = { apiContract: CODENOMAD_API_CONTRACT, serverId: owner ?? "local",
        localRequest: false, serversUsable: true, serversManageable: true, secretEntryAllowed: false }
    } else if (path === "/api/auth/status") body = { authenticated: true }
    else if (path === "/api/workspaces") {
      if (request.method() === "POST") {
        assert(owner, "web restore must never create a local workspace")
        creates.push(owner)
        requestIds.push(request.postDataJSON().requestId)
        if (creates.length === 1 && ["rate-limited", "uncertain"].includes(mode)) {
          return route.fulfill({ status: mode === "rate-limited" ? 429 : 499, json: { error: "refused" } })
        }
        body = { ...descriptor("opened", "/same"), requestId: request.postDataJSON().requestId }
        inventories.get(owner)!.push(body)
      } else body = owner ? inventories.get(owner) : []
    } else if (path.endsWith("/worktrees")) body = { isGitRepo: false, worktrees: [] }
    else if (path.includes("/instance/api/")) body = { data: [], cursor: {} }
    await route.fulfill({ json: body, headers: owner && path === "/api/meta" ? { [RELAY_AUTHORITY_HEADER]: "x".repeat(43) } : undefined })
  })
  try {
    await page.goto(url.replace(new URL(url).hostname, "192.0.2.1"), { waitUntil: "domcontentloaded" })
    await page.locator('[data-restoring="false"]').waitFor()
    assert.equal(await page.evaluate(() => window.isSecureContext), false, "use a real insecure LAN-style origin")
    const tabs = () => page.evaluate(() => (window as any).restoreFixture.tabs())
    let state = await tabs()
    assert.equal(state.length, 2)
    assert.equal(state[0].id, "instance:a~same", "saved record wins over folder occurrence zero")
    assert.equal(state[0].drafts.__no_session_draft__, "draft-a")
    assert.equal(state[1].drafts.__no_session_draft__, "draft-b")
    assert.deepEqual(creates, [], "automatic restoration creates nothing")
    if (mode === "offline") {
      assert.equal(state[1].kind, "remote-restore")
      await page.getByRole("button", { name: "Connect", exact: true }).click()
      assert.equal(await page.getByLabel("Password", { exact: true }).isDisabled(), true)
      assert.equal(await page.getByLabel("Pairing link", { exact: true }).isDisabled(), true)
      healthy = true
      await page.getByRole("button", { name: "Retry", exact: true }).click()
    } else if (!["reuse", "offline"].includes(mode)) {
      assert.equal(state[1].kind, "remote-restore")
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      assert.deepEqual(creates, [], "Retry only rebinds web records")
      await page.getByRole("button", { name: "Open", exact: true }).click()
      if (["rate-limited", "uncertain"].includes(mode)) {
        const settled = () => page.waitForFunction(() => {
          const button = document.querySelector<HTMLButtonElement>("[data-remote-restore] button")
          return !button || !button.disabled
        })
        await settled()
        await page.getByRole("button", { name: "Open", exact: true }).click()
        await settled()
        if (mode === "uncertain") {
          assert.deepEqual(creates, ["b"], "an uncertain 499 never replays its creation")
          assert.equal((await tabs())[1].drafts.__no_session_draft__, "draft-b")
          return
        }
      }
    }
    await page.waitForFunction(() => (window as any).restoreFixture.tabs().every((tab: any) => tab.kind === "instance"))
    const expectedCreates = mode === "rate-limited" ? ["b", "b"] : mode === "missing" ? ["b"] : []
    assert.deepEqual(creates, expectedCreates, "only explicit Open creates a missing occurrence")
    for (const id of requestIds) assert.match(id, /^restore-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i, "HTTP creation IDs use the shared cryptographic UUID helper")
    state = await tabs()
    assert.deepEqual(state.map((tab: any) => tab.drafts.__no_session_draft__), ["draft-a", "draft-b"])
    assert.equal(await page.evaluate(() => (window as any).restoreFixture.active()), state[1].id)
    const views = () => page.evaluate(() => {
      const f = (window as any).restoreFixture
      return f.tabs().map((tab: any) => f.view(tab.id.slice("instance:".length))?.rightPanelTab)
    })
    assert.deepEqual(await views(), ["status", "files"])
    await page.waitForFunction(() => {
      const snapshot = JSON.parse(sessionStorage.getItem("codenomad.client-state.v1")!)
      return snapshot.session.tabs.every((tab: any) => tab.workspaceId)
    })
    await page.reload()
    await page.locator('[data-restoring="false"]').waitFor()
    assert.deepEqual(await tabs(), state, "reload keeps backend binding, order and drafts")
    assert.deepEqual(await views(), ["status", "files"])
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })))
    // A fresh renderer receives only the browser-cloned sessionStorage, as after mobile discard.
    const replacement = page.waitForEvent("popup")
    await page.evaluate(() => window.open(location.href))
    const discarded = page
    page = await replacement
    page.on("pageerror", error => errors.push(error.message))
    await discarded.close()
    await page.locator('[data-restoring="false"]').waitFor()
    assert.deepEqual(await tabs(), state, "discarded page restores its tab-owned snapshot")
    assert.deepEqual(await views(), ["status", "files"])
    assert.deepEqual(creates, expectedCreates)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

function descriptor(id: string, path: string) {
  return { id, path, status: "ready", port: 1234, proxyPath: `/workspaces/${id}/instance`, binaryId: "fixture", createdAt: "", updatedAt: "" }
}

const primaryCases = [
  ...[false, true].flatMap(multiBackend => ["open", "retry"].map(recovery => ({ multiBackend, recovery, initiallyUnavailable: false }))),
  { multiBackend: false, recovery: "retry", initiallyUnavailable: true },
]
for (const { multiBackend, recovery, initiallyUnavailable } of primaryCases) {
  test(`web missing primary record preserves its occurrence (${multiBackend}, ${recovery}, unavailable=${initiallyUnavailable})`, async () => {
    const context = await browser.newContext(), page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.setDefaultNavigationTimeout(60_000)
    const errors: string[] = [], creates: string[] = [], projects: ReturnType<typeof descriptor>[] = []
    let reads = 0, unavailable = initiallyUnavailable
    page.on("pageerror", error => errors.push(error.message))
    await context.addInitScript(() => {
      ;(window as any).__name = new Function("value", "return value")
      Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "web", __CODENOMAD_WINDOW_CONTEXT__: "remote" })
      window.EventSource = class extends EventTarget { close() {} } as any
      if (!sessionStorage.getItem("codenomad.client-state.v1")) sessionStorage.setItem("codenomad.client-state.v1", JSON.stringify({
        version: 1, revision: 1, savedAt: 1, layout: {}, session: { activeTabIndex: 0, tabs: [{
          kind: "workspace", folder: "/same", workspaceId: "gone", occurrence: 0,
          drafts: { __no_session_draft__: "primary-backend-draft" }, attachments: {},
          scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
        }] },
      }))
    })
    await context.route(/\/(?:api|workspaces)\//, async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      assert.equal(path.startsWith("/api/backends/"), false, "primary recovery keeps its host API")
      let body: any = {}
      if (path.startsWith("/api/storage/")) body = path.endsWith("/config/ui") ? { settings: { multiBackend } } : {}
      else if (path === "/api/meta") body = { apiContract: CODENOMAD_API_CONTRACT, serverId: "local", localRequest: false }
      else if (path === "/api/workspaces") {
        if (request.method() === "POST") {
          creates.push(request.postDataJSON().path)
          body = { ...descriptor("opened", "/same"), requestId: request.postDataJSON().requestId }
          projects.push(body)
        } else {
          reads++
          if (unavailable) return route.fulfill({ status: 503, json: { error: "unavailable" } })
          body = projects
        }
      } else if (path.endsWith("/worktrees")) body = { isGitRepo: false, worktrees: [] }
      else if (path.includes("/instance/api/")) body = { data: [], cursor: {} }
      await route.fulfill({ json: body })
    })
    const tabs = () => page.evaluate(() => (window as any).restoreFixture.tabs())
    const waitReady = () => page.locator('[data-restoring="false"]').waitFor()
    const waitIdle = () => page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("[data-remote-restore] button:disabled"))
    try {
      await page.goto(url)
      await waitReady()
      assert.equal((await tabs()).length, 1, "the missing primary record keeps its tab")
      assert.equal((await tabs())[0].drafts.__no_session_draft__, "primary-backend-draft")
      assert.deepEqual(creates, [])
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
      await page.reload()
      await waitReady()
      assert.equal((await tabs())[0].kind, "remote-restore")
      assert.equal((await tabs())[0].drafts.__no_session_draft__, "primary-backend-draft")
      assert.equal(await page.getByRole("button", { name: "Connect", exact: true }).count(), 0)
      unavailable = false
      const before = reads
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      await waitIdle()
      assert.ok(reads > before, "Retry reads the primary inventory")
      assert.deepEqual(creates, [], "reload and Retry never create")
      if (recovery === "retry") projects.push(descriptor("resumed", "/same"))
      await page.getByRole("button", { name: recovery === "retry" ? "Retry" : "Open", exact: true }).click()
      await page.waitForFunction(() => (window as any).restoreFixture.tabs()[0]?.kind === "instance")
      assert.equal((await tabs())[0].drafts.__no_session_draft__, "primary-backend-draft")
      assert.deepEqual(creates, recovery === "open" ? ["/same"] : [])
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
      await page.reload()
      await waitReady()
      assert.equal((await tabs())[0].id, `instance:${recovery === "open" ? "opened" : "resumed"}`)
      assert.equal((await tabs())[0].drafts.__no_session_draft__, "primary-backend-draft")
      assert.deepEqual(creates, recovery === "open" ? ["/same"] : [])
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
}
