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
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
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
  assert.equal(await remote.locator("a").getAttribute("data-preview-link-title"), null)
  await local.locator("a").click()
  await local.locator("iframe").waitFor()
  assert.match(await local.locator("iframe").getAttribute("src") ?? "", /^\/previews\/local-\d+\/app\?q=1#hash$/)
  await page.evaluate(() => { (window as any).previewRouting.detach(); (window as any).previewRouting.reattach() })
  await page.waitForFunction(() => document.querySelector('[data-owner="remote"] a')?.hasAttribute("data-preview-link-title"))
  await remote.locator("a").click()
  await remote.locator("iframe").waitFor()
  assert.match(await remote.locator("iframe").getAttribute("src") ?? "", /^https:\/\/preview.example.invalid\/previews\/remote-\d+\/app\?q=1#hash$/)
  await remote.locator("form input").fill("https://example.com/next")
  await remote.locator("form input").press("Enter")
  await page.waitForFunction(() => (window as any).previewRouting.calls.filter((call: any) => call.owner === "remote" && call.method === "POST").length === 2
    && (window as any).previewRouting.calls.some((call: any) => call.owner === "remote" && call.method === "DELETE"))
  await page.evaluate(() => (window as any).previewRouting.hostMeta())
  assert.equal(await page.locator("[data-host-version]").textContent(), "host-version")
  const calls = await page.evaluate(() => (window as any).previewRouting.calls)
  assert.ok(calls.some((call: any) => call.owner === "remote" && call.method === "DELETE"))
  assert.ok(calls.filter((call: any) => call.owner === "remote").every((call: any) => call.url.startsWith("https://preview.example.invalid/")))
  assert.ok(calls.filter((call: any) => call.method === "POST").every((call: any) => call.body.sessionId === "session"))
}))

test("revoked metadata cannot enable links or block a new generation; missing owners never fall back to local", async () => fixturePage(async page => {
  await page.evaluate(() => { const f = (window as any).previewRouting; f.hold("meta"); f.detach(); f.reattach() })
  await page.waitForFunction(() => (window as any).previewRouting.pending === 1)
  await page.evaluate(() => { const f = (window as any).previewRouting; f.detach(); f.reattach() })
  await page.waitForFunction(() => (window as any).previewRouting.pending === 2)
  await page.evaluate(() => (window as any).previewRouting.releaseOne())
  assert.equal(await page.locator('[data-owner="remote"] a').getAttribute("data-preview-link-title"), null)
  await page.evaluate(() => (window as any).previewRouting.release())
  await page.waitForFunction(() => document.querySelector('[data-owner="remote"] a')?.hasAttribute("data-preview-link-title"))
  await page.locator('[data-owner="remote"] a').click()
  await page.locator('[data-owner="remote"] iframe').waitFor()
  await page.evaluate(() => (window as any).previewRouting.missing())
  await page.waitForFunction(() => !document.querySelector('[data-owner="remote"] iframe')
    && !document.querySelector('[data-owner="remote"] a')?.hasAttribute("data-preview-link-title"))
  const calls = await page.evaluate(() => (window as any).previewRouting.calls)
  assert.equal(calls.filter((call: any) => call.owner === "local" && call.method === "POST").length, 0)
  assert.equal(calls.filter((call: any) => call.owner === "local" && call.url === "/api/meta").length, 1)
}))

test("a revoked pending Markdown preview never mounts a guest", async () => fixturePage(async page => {
  await page.evaluate(() => { const f = (window as any).previewRouting; f.detach(); f.reattach() })
  await page.waitForFunction(() => document.querySelector('[data-owner="remote"] a')?.hasAttribute("data-preview-link-title"))
  await page.evaluate(() => (window as any).previewRouting.hold("preview"))
  await page.locator('[data-owner="remote"] a').click()
  await page.waitForFunction(() => (window as any).previewRouting.pending === 1)
  await page.evaluate(() => { const f = (window as any).previewRouting; f.detach(); f.release() })
  await page.waitForFunction(() => (window as any).previewRouting.calls.some((call: any) => call.owner === "remote" && call.method === "DELETE"))
  assert.equal(await page.locator('[data-owner="remote"] iframe').count(), 0)
}))
