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
          kind: "workspace", folder: "/same", backendId, serverId: backendId, workspaceId: `${backendId}~same`, occurrence: 0,
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
  await context.route(url => /^\/(?:api|workspaces)\//.test(url.pathname), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    const owner = /^\/api\/backends\/([ab])/.exec(pathname)?.[1]
    const path = owner ? pathname.slice(`/api/backends/${owner}`.length) : pathname
    let body: any = {}
    if (path.startsWith("/api/storage/")) body = owner ? {} : path.endsWith("/config/ui") ? { settings: { multiBackend: true, locale: "en" } }
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
    assert.deepEqual(creates, ["reuse", "offline"].includes(mode) ? [] : ["b"], "only a missing record on an admitted server is created")
    if (mode === "offline") {
      assert.equal(state[1].kind, "remote-restore")
      await page.getByRole("button", { name: "Connect", exact: true }).click()
      assert.equal(await page.getByLabel("Password", { exact: true }).isDisabled(), true)
      assert.equal(await page.getByLabel("New pairing link", { exact: true }).isDisabled(), true)
      healthy = true
      await page.getByRole("button", { name: "Retry", exact: true }).click()
    } else if (["rate-limited", "uncertain"].includes(mode)) {
      assert.equal(state[1].kind, "remote-restore")
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      await page.waitForFunction(() => !document.querySelector("[data-remote-restore] button:disabled"))
      if (mode === "uncertain") {
        assert.deepEqual(creates, ["b"], "an uncertain 499 never replays its creation")
        assert.equal((await tabs())[1].drafts.__no_session_draft__, "draft-b")
        return
      }
    }
    await page.waitForFunction(() => (window as any).restoreFixture.tabs().every((tab: any) => tab.kind === "instance"))
    const expectedCreates = mode === "rate-limited" ? ["b", "b"] : mode === "missing" ? ["b"] : []
    assert.deepEqual(creates, expectedCreates)
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

for (const mode of ["reuse", "disappears", "failed-reconnect"]) test(mode === "failed-reconnect"
  ? "web reload keeps failed reconnect status after a deferred first-open inventory"
  : mode === "disappears"
  ? "web reload preserves the active remote tab when the next inventory omits its project during hydration"
  : "web reload restores the active remote tab when SSE opens during its inventory", { timeout: 90_000 }, async () => {
  const context = await browser.newContext(), page = await context.newPage()
  const creates: string[] = []
  const disappears = mode === "disappears", failedReconnect = mode === "failed-reconnect"
  let reload = false, reads = 0, remotePresent = true, remoteAvailable = true
  const releaseHydration = Promise.withResolvers<void>(), omitProject = Promise.withResolvers<void>()
  await context.addInitScript(disappears => {
    ;(window as any).__name = (value: unknown) => value
    Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "web", __CODENOMAD_WINDOW_CONTEXT__: "remote" })
    let openRemote: () => void
    let connections = 0
    Object.assign(window, { openRemoteEvents: () => openRemote(), remoteConnections: () => connections })
    window.EventSource = class extends EventTarget {
      constructor(private url: string) { super() }
      set onopen(open: () => void) {
        if (new URL(this.url, location.href).pathname === "/api/backends/a/api/events") {
          openRemote = open
          connections++
        }
      }
      close() {}
    } as any
    if (!sessionStorage.getItem("codenomad.client-state.v1")) sessionStorage.setItem("codenomad.client-state.v1", JSON.stringify({
      version: 1, revision: 1, savedAt: 1, layout: {}, session: { activeTabIndex: 1, tabs: [
        { folder: "/local", workspaceId: "same" }, { folder: "/remote", workspaceId: "a~same", backendId: "a", serverId: "a" },
      ].map(project => ({ kind: "workspace", ...project,
        ...(disappears && project.backendId ? { activeParentSessionId: "held-session", activeSessionId: "held-session" } : {}),
        drafts: { __no_session_draft__: project.folder,
          ...(disappears && project.backendId ? { "held-session": "unsent conversation draft" } : {}) },
        attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {}, viewState: { version: 1, rightPanelTab: "files" } })) },
    }))
  }, disappears)
  await context.route(url => /^\/(?:api|workspaces)\//.test(url.pathname), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    const remote = pathname.startsWith("/api/backends/a/")
    const path = remote ? pathname.slice("/api/backends/a".length) : pathname
    let body: unknown = {}
    if (path === "/api/meta") {
      if (remote && !remoteAvailable) return route.fulfill({ status: 503, json: { error: "offline" } })
      body = { apiContract: CODENOMAD_API_CONTRACT, serverId: remote ? "a" : "local", localRequest: !remote }
    }
    else if (path === "/api/auth/status") body = { authenticated: true }
    else if (!remote && path.endsWith("/config/ui")) body = { settings: { multiBackend: true, locale: "en" } }
    else if (!remote && path.endsWith("/state/ui")) body = { remoteServers: [
      { id: "a", name: "Server A", baseUrl: "https://a.test", skipTlsVerify: false, createdAt: "", updatedAt: "" },
    ] }
    else if (path === "/api/workspaces") {
      if (request.method() === "POST") {
        creates.push(pathname)
        return route.fulfill({ status: 404, json: {} })
      }
      if (remote && reload && ++reads === 1) {
        // Dispatch open while the admission request is held. Wait for the
        // handler's module import before letting the response reach Chromium.
        await page.evaluate(async () => {
          ;(window as any).openRemoteEvents()
          const registryModule = "/src/stores/remote-backends.ts"
          await import(registryModule)
        })
        if (failedReconnect) {
          remoteAvailable = false
          await page.evaluate(() => (window as any).restoreFixture.disconnect())
          await page.waitForFunction(() => (window as any).restoreFixture.state() === "unreachable")
        }
      }
      if (remote && reload && disappears && reads === 2) {
        // Wait until the admitted record owns the tab and its saved session read is in flight.
        await omitProject.promise
        remotePresent = false
      }
      body = remote && !remotePresent ? [] : [descriptor("same", remote ? "/remote" : "/local")]
    } else if (path.endsWith("/worktrees")) body = { isGitRepo: false, worktrees: [] }
    else if (remote && path.endsWith("/instance/api/session/held-session")) {
      if (reload) await releaseHydration.promise
      body = { data: { id: "held-session", title: "Saved conversation", projectID: "global", location: { directory: "/remote" },
        time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } }
    }
    else if (path.includes("/instance/api/")) body = { data: [], cursor: {} }
    await route.fulfill({ json: body, headers: remote && path === "/api/meta" ? { [RELAY_AUTHORITY_HEADER]: "x".repeat(43) } : undefined })
  })
  try {
    const restored = async () => {
      await page.locator('[data-restoring="false"]').waitFor()
      return page.evaluate(() => (window as any).restoreFixture.tabs().map((tab: any) => tab.id))
    }
    await page.goto(url)
    const expected = ["instance:same", "instance:a~same"]
    assert.deepEqual(await restored(), expected)
    reload = true
    await Promise.all([
      disappears && page.waitForRequest(request =>
        new URL(request.url()).pathname === "/api/backends/a/workspaces/same/instance/api/session/held-session"),
      page.reload({ waitUntil: "domcontentloaded" }),
    ])
    if (failedReconnect) {
      await restored()
      const state = () => page.evaluate(() => (window as any).restoreFixture.state())
      const tabs = () => page.evaluate(() => (window as any).restoreFixture.tabs())
      await page.evaluate(() => (window as any).restoreFixture.waitForInventory())
      assert.equal(await state(), "unreachable", "the older opening must not repair a newer failed reconnect")
      assert.equal(reads, 1, "only admission's inventory ran before the failed reconnect")
      const suspended = await tabs()
      assert.deepEqual(suspended.map((tab: any) => tab.kind), ["instance", "remote-restore"])
      assert.deepEqual(suspended.map((tab: any) => tab.drafts.__no_session_draft__), ["/local", "/remote"])
      assert.equal(await page.evaluate(() => (window as any).restoreFixture.active()), suspended[1].id)
      remoteAvailable = true
      await page.evaluate(() => (window as any).restoreFixture.disconnect())
      await page.waitForFunction(() => (window as any).remoteConnections() === 2)
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/backends/a/api/workspaces")
      await page.evaluate(() => (window as any).openRemoteEvents())
      await refreshed
      await page.waitForFunction(() => (window as any).restoreFixture.state() === "compatible")
      assert.equal(reads, 2, "the next valid opening refreshes inventory once")
      assert.equal(await state(), "compatible")
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      await page.locator('[data-ready]').filter({ hasText: "instance:a~same" }).waitFor()
      assert.deepEqual((await tabs()).map((tab: any) => tab.id), expected)
      assert.deepEqual((await tabs()).map((tab: any) => tab.drafts.__no_session_draft__), ["/local", "/remote"])
      assert.deepEqual(creates, [], "reload, reconnect and Retry only rebind existing records")
      return
    }
    if (disappears) {
      await page.getByText("instance:a~same", { exact: true }).waitFor()
      omitProject.resolve()
      await page.waitForFunction(() => {
        const f = (window as any).restoreFixture
        return !f.tabs().some((tab: any) => tab.id === "instance:a~same")
      })
      assert.equal(await page.locator('[data-restoring="true"]').count(), 1, "hydration remains pending at removal")
      releaseHydration.resolve()
      await restored()
      const tabs = () => page.evaluate(() => (window as any).restoreFixture.tabs())
      const state = await tabs()
      assert.equal(state.length, 2, "the missing remote project keeps its tab")
      assert.equal(state[0].id, "instance:same")
      assert.equal(state[0].drafts.__no_session_draft__, "/local")
      assert.equal(state[1].kind, "remote-restore")
      assert.equal(state[1].folder, "/remote")
      assert.deepEqual(state[1].drafts, { __no_session_draft__: "/remote", "held-session": "unsent conversation draft" })
      assert.equal(await page.evaluate(() => (window as any).restoreFixture.active()), state[1].id)
      const placeholder = page.locator('[data-remote-restore="a"]')
      const retry = placeholder.getByRole("button", { name: "Retry", exact: true })
      await retry.click()
      await page.waitForFunction(() => !document.querySelector("[data-remote-restore] button:disabled"))
      assert.equal(reads, 3, "Retry reads inventory while the project remains absent")
      assert.deepEqual(await tabs(), state)
      remotePresent = true
      await retry.click()
      await page.locator('[data-ready]').filter({ hasText: "instance:a~same" }).waitFor()
      await page.waitForFunction(() => (window as any).restoreFixture.tabs()[1]?.drafts["held-session"] === "unsent conversation draft")
      assert.deepEqual((await tabs()).map((tab: any) => tab.id), expected)
      assert.deepEqual((await tabs())[1].drafts, state[1].drafts)
      assert.equal(await page.evaluate(() => (window as any).restoreFixture.view("a~same")?.rightPanelTab), "files")
      assert.equal(reads, 4)
      assert.deepEqual(creates, ["/api/backends/a/api/workspaces"], "Retry attempts a fresh record while the original is absent")
      return
    }
    assert.deepEqual(await restored(), expected, "both existing occurrences must rebind without Retry")
    assert.equal(await page.locator("[data-ready]").textContent(), "instance:a~same", "keep the saved remote selection")
    await page.evaluate(() => (window as any).restoreFixture.disconnect())
    await page.waitForFunction(() => (window as any).remoteConnections() === 2)
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/backends/a/api/workspaces")
    await page.evaluate(() => (window as any).openRemoteEvents())
    assert.equal((await refreshed).status(), 200, "a real reconnect also reads inventory")
    assert.equal(reads, 3, "admission, first open and reconnect each reconcile once")
    assert.deepEqual(creates, [], "reload and reconnect do not create any workspace")
  } finally {
    omitProject.resolve()
    releaseHydration.resolve()
    await context.close()
  }
})

const primaryCases = [
  ...[false, true].map(multiBackend => ({ multiBackend, initiallyUnavailable: false })),
  { multiBackend: false, initiallyUnavailable: true },
]
for (const { multiBackend, initiallyUnavailable } of primaryCases) {
  test(`web missing primary record preserves its occurrence (multiBackend=${multiBackend}, unavailable=${initiallyUnavailable})`, async () => {
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
    await context.route(url => /^\/(?:api|workspaces)\//.test(url.pathname), async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      assert.equal(path.startsWith("/api/backends/"), false, "primary recovery keeps its host API")
      let body: any = {}
      if (path.startsWith("/api/storage/")) body = path.endsWith("/config/ui") ? { settings: { multiBackend, locale: "en" } } : {}
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
    try {
      await page.goto(url)
      await waitReady()
      assert.equal((await tabs()).length, 1, "the missing primary record keeps its tab")
      assert.equal((await tabs())[0].drafts.__no_session_draft__, "primary-backend-draft")
      if (initiallyUnavailable) {
        assert.equal((await tabs())[0].kind, "remote-restore")
        assert.deepEqual(creates, [])
        unavailable = false
        const before = reads
        await page.getByRole("button", { name: "Retry", exact: true }).click()
        await page.waitForFunction(() => (window as any).restoreFixture.tabs()[0]?.kind === "instance")
        assert.ok(reads > before, "Retry reads the primary inventory")
      }
      await page.waitForFunction(() => (window as any).restoreFixture.tabs()[0]?.kind === "instance")
      assert.equal((await tabs())[0].drafts.__no_session_draft__, "primary-backend-draft")
      assert.deepEqual(creates, ["/same"])
      await page.reload()
      await waitReady()
      assert.equal((await tabs())[0].id, "instance:opened")
      assert.equal((await tabs())[0].drafts.__no_session_draft__, "primary-backend-draft")
      assert.deepEqual(creates, ["/same"])
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
}
