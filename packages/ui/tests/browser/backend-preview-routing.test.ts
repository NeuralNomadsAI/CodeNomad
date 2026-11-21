import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

async function fixturePage(run: (page: Page) => Promise<void>) {
  const fixture = await borrowFixture({ name: "backend-preview-routing", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-preview-routing.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: 'window.EventSource = class extends EventTarget { close() {} }' })
  await page.route(url => url.pathname.startsWith("/api/"), route => route.fulfill({ json: {} }))
  await page.route("**/previews/**", route => route.request().resourceType() === "document"
    ? route.fulfill({ contentType: "text/html", body: "<html><body>Preview fixture</body></html>" }) : route.fallback())
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => (window as any).previewRouting && document.querySelectorAll('.markdown-body a').length === 2
      && document.querySelector('[data-owner="local"] a')?.hasAttribute("data-preview-link-title"))
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, body: await page.locator("body").innerText(), fixture: await page.evaluate(() => Boolean((window as any).previewRouting)) })
    throw error
  } finally { await browser.close(); await fixture.close() }
}

test("Markdown availability and live preview navigation follow their backend, keeping local frame paths and host metadata", async () => fixturePage(async page => {
  const local = page.locator('[data-owner="local"]'), remote = page.locator('[data-owner="remote"]')
  const localPreview = page.locator('[data-preview-instance="same"]'), remotePreview = page.locator('[data-preview-instance="preview_remote~same"]')
  assert.equal(await remote.locator("a").getAttribute("data-preview-link-title"), null)
  await local.locator("a").click()
  await localPreview.locator("iframe").waitFor()
  assert.match(await localPreview.locator("iframe").getAttribute("src") ?? "", /^\/previews\/local-\d+\/app\?q=1#hash$/)
  await page.evaluate(() => { (window as any).previewRouting.detach(); (window as any).previewRouting.reattach() })
  await page.waitForFunction(() => document.querySelector('[data-owner="remote"] a')?.hasAttribute("data-preview-link-title"))
  await remote.locator("a").click()
  await remotePreview.locator("iframe").waitFor()
  assert.match(await remotePreview.locator("iframe").getAttribute("src") ?? "", /^http:\/\/cap-remote-\d+.preview.localhost:1234\/previews\/remote-\d+\/app\?q=1#hash$/)
  await remotePreview.locator("form input").fill("https://example.com/next")
  await remotePreview.locator("form input").press("Enter")
  await page.waitForFunction(() => (window as any).previewRouting.calls.filter((call: any) => call.owner === "remote" && call.method === "POST").length === 2
    && (window as any).previewRouting.calls.some((call: any) => call.owner === "remote" && call.method === "DELETE"))
  await page.evaluate(() => (window as any).previewRouting.hostMeta())
  assert.equal(await page.locator("[data-host-version]").textContent(), "host-version")
  const calls = await page.evaluate(() => (window as any).previewRouting.calls)
  assert.ok(calls.some((call: any) => call.owner === "remote" && call.method === "DELETE"))
  assert.ok(calls.filter((call: any) => call.owner === "remote").every((call: any) => call.url.startsWith("https://preview.example.invalid/")))
  assert.ok(calls.filter((call: any) => call.method === "POST").every((call: any) => call.body.sessionId === "session"))
}))

test("preview links require current backend metadata and host permission; missing owners never fall back to local", async () => fixturePage(async page => {
  const linkEnabled = (expected: boolean) => page.waitForFunction(enabled =>
    document.querySelector('[data-owner="remote"] a')?.hasAttribute("data-preview-link-title") === enabled, expected)
  await page.evaluate(() => { const f = (window as any).previewRouting; f.hold("meta"); f.detach(); f.reattach() })
  await page.waitForFunction(() => (window as any).previewRouting.pending === 1)
  await page.evaluate(() => { const f = (window as any).previewRouting; f.detach(); f.reattach() })
  await page.waitForFunction(() => (window as any).previewRouting.pending === 2)
  await page.evaluate(() => (window as any).previewRouting.releaseOne())
  assert.equal(await page.locator('[data-owner="remote"] a').getAttribute("data-preview-link-title"), null)
  await page.evaluate(() => (window as any).previewRouting.release())
  await linkEnabled(true)
  const remoteReads = () => page.evaluate(() => (window as any).previewRouting.calls
    .filter((call: any) => call.owner === "remote" && call.url.endsWith("/api/meta")).length)
  const reads = await remoteReads()
  await page.evaluate(() => (window as any).previewRouting.hostPreviews(true))
  await linkEnabled(false)
  await page.evaluate(() => (window as any).previewRouting.hostPreviews(false))
  await linkEnabled(true)
  assert.equal(await remoteReads(), reads)
  await page.locator('[data-owner="remote"] a').click()
  await page.locator('[data-preview-instance="preview_remote~same"] iframe').waitFor()
  const localMetaReads = await page.evaluate(() => (window as any).previewRouting.calls
    .filter((call: any) => call.owner === "local" && call.url === "/api/meta").length)
  await page.evaluate(() => (window as any).previewRouting.missing())
  await page.waitForFunction(() => !document.querySelector('[data-session-id="session"] iframe')
    && !document.querySelector('[data-owner="remote"] a')?.hasAttribute("data-preview-link-title"))
  const calls = await page.evaluate(() => (window as any).previewRouting.calls)
  assert.equal(calls.filter((call: any) => call.owner === "local" && call.method === "POST").length, 0)
  assert.equal(localMetaReads, 4, "host and local attachment read once, plus two explicit host refreshes")
  assert.equal(calls.filter((call: any) => call.owner === "local" && call.url === "/api/meta").length, localMetaReads)
}))

test("a revoked pending Markdown preview never mounts a guest", async () => fixturePage(async page => {
  await page.evaluate(() => { const f = (window as any).previewRouting; f.detach(); f.reattach() })
  await page.waitForFunction(() => document.querySelector('[data-owner="remote"] a')?.hasAttribute("data-preview-link-title"))
  await page.evaluate(() => (window as any).previewRouting.hold("preview"))
  await page.locator('[data-owner="remote"] a').click()
  await page.waitForFunction(() => (window as any).previewRouting.pending === 1)
  await page.evaluate(() => { const f = (window as any).previewRouting; f.detach(); f.release() })
  await page.waitForFunction(() => (window as any).previewRouting.calls.some((call: any) => call.owner === "remote" && call.method === "DELETE"))
  assert.equal(await page.locator('[data-session-id="session"] iframe').count(), 0)
}))
