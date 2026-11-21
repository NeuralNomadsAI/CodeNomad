import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, fixtureUrl: string
before(async () => {
  const fixture = await borrowFixture({ name: "remote-preview-metadata", routes: [{ path: "/fixture", html:
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/header-windows.tsx"></script></body></html>' }] })
  fixtureUrl = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const recovery of ["none", "open-after-failure", "reconnect-pending", "reconnect-pending-success", "navigation"] as const) test(`remote preview controls wait for host metadata (${recovery})`, { timeout: 60_000 }, async () => {
  const reconnectWhilePending = recovery === "reconnect-pending" || recovery === "reconnect-pending-success"
  const fails = recovery === "open-after-failure" || recovery === "reconnect-pending" || recovery === "navigation"
  const events = await fixtureEventStream(fixtureUrl)
  const { origin, port, hostname } = new URL(fixtureUrl)
  const meta = { localUrl: origin, eventsUrl: "/api/events", host: hostname, hostLabel: "Fixture",
    listeningMode: "local", localPort: Number(port), workspaceRoot: "/repo", addresses: [], previewsUnavailable: false }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  let releaseHost!: () => void
  const hostGate = new Promise<void>(resolve => { releaseHost = resolve })
  let releaseFollowup!: () => void
  const followupGate = new Promise<void>(resolve => { releaseFollowup = resolve })
  let releaseEvents!: (connect: boolean) => void
  const eventsGate = new Promise<boolean>(resolve => { releaseEvents = resolve })
  let hostReads = 0
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/auth/status") return route.fulfill({ json: { authenticated: true } })
    if (path === "/api/meta") {
      if (++hostReads === 1) {
        await hostGate
        if (fails) return route.fulfill({ status: 503, json: {} })
      } else if (recovery === "reconnect-pending") await followupGate
    }
    return route.fulfill({ json: path.endsWith("/api/meta") ? meta : path.endsWith("/api/panel-extensions") ? [] : {} })
  })
  await page.route(url => url.pathname === "/api/events", async route => {
    if (await eventsGate) await route.continue({ url: events.url })
    else await route.abort()
  })
  const waitForHostOpen = (count: number) => page.waitForFunction(
    count => (window as any).fixture?.hostEventOpens() === count, count, { timeout: 5000 },
  )
  const connectHost = async () => {
    releaseEvents(true)
    await waitForHostOpen(1)
  }
  const reconnectHost = async () => {
    events.disconnect()
    await waitForHostOpen(2)
  }
  const inline = page.locator('.session-header-expanded-actions button[aria-label="Open web preview"]')
  const overflow = page.getByRole("menuitemcheckbox", { name: "Open web preview" })
  const link = page.getByRole("link", { name: "Local preview" })
  const checkControls = async (count: number) => {
    await page.locator(".session-header-actions-menu").click()
    await page.getByRole("menuitem", { name: "Message content", exact: true }).waitFor()
    assert.equal(await inline.count(), count)
    assert.equal(await overflow.count(), count)
    await page.keyboard.press("Escape")
    await page.getByRole("menu").waitFor({ state: "hidden" })
  }
  try {
    const url = `${fixtureUrl}?remotePreview&assistant&links`
    if (reconnectWhilePending) {
      // The first stream open precedes preview demand; only its reconnect can queue recovery.
      await page.goto(`${url}&hostEventsBeforeMount`, { waitUntil: "commit" })
      await page.waitForFunction(() => (window as any).hostEventsBeforeMountReady)
      releaseEvents(true)
      await waitForHostOpen(1)
    } else await page.goto(url)
    await page.waitForFunction(() => (window as any).fixture?.remoteMetaReady())
    await link.waitFor()
    assert.equal(hostReads, 1)
    assert.equal(await link.getAttribute("data-preview-link-title"), null)
    await checkControls(0)

    // Observe the exact in-flight host read without racing a retry after the 503.
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.hostRead = f.readHostMeta().then(() => true, () => false)
    })
    if (reconnectWhilePending) {
      await reconnectHost()
      assert.equal(hostReads, 1, "the original host read is still pending after reconnect")
      assert.equal(await link.getAttribute("data-preview-link-title"), null)
      await checkControls(0)
    }
    const freshRead = recovery === "reconnect-pending" ? page.waitForRequest(
      request => new URL(request.url()).pathname === "/api/meta", { timeout: 5000 },
    ) : undefined
    // The initial read observation and the fresh request can settle in either order.
    void freshRead?.catch(() => undefined)
    releaseHost()
    assert.equal(await page.evaluate(() => (window as any).fixture.hostRead), !fails)
    if (freshRead) {
      await freshRead
      assert.equal(await link.getAttribute("data-preview-link-title"), null)
      await checkControls(0)
      releaseFollowup()
    }
    if (recovery === "navigation" || recovery === "open-after-failure") {
      assert.equal(await link.getAttribute("data-preview-link-title"), null)
      await checkControls(0)
      if (recovery === "navigation") await page.reload()
      else await connectHost()
    }

    await inline.waitFor({ state: "attached", timeout: 5000 })
    await page.locator("a[data-preview-link-title]").waitFor()
    await checkControls(1)
    assert.equal(hostReads, fails ? 2 : 1)
  } finally {
    releaseHost()
    releaseFollowup()
    releaseEvents(false)
    await page.close()
    await events.close()
  }
})
