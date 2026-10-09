import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "session-child-activity-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-child-activity.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("busy subsessions show a dot on their collapsed parent without reshaping the list", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  const rows = () => page.locator(".session-item-base").evaluateAll(elements => elements.map(el => el.getAttribute("data-session-id")))
  const dot = (sessionId: string) => page.locator(`[data-session-id="${sessionId}"] .session-child-activity`)
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.locator('[data-session-id="other"]').waitFor()
    assert.deepEqual(await rows(), ["work", "other"])
    const workBox = await page.locator('[data-session-id="work"]').boundingBox()

    // A subsession of another conversation starts: nothing opens, the collapsed parent gets a dot.
    await page.evaluate(() => (window as any).fixture.status("other-grandchild", "working"))
    await dot("other").waitFor()
    assert.deepEqual(await rows(), ["work", "other"])
    assert.deepEqual(await page.locator('[data-session-id="work"]').boundingBox(), workBox)
    assert.equal(await dot("other").getAttribute("aria-label"), "1 subsession working")
    assert.equal(await dot("other").getAttribute("data-child-activity"), "working")
    // The dot is separate from the parent's own status and carries no label text.
    assert.equal(await page.locator('[data-session-id="other"] .session-item-status-label').count(), 0)
    assert.equal((await dot("other").innerText()).trim(), "")

    // Input requests outrank work and are counted in the tooltip.
    await page.evaluate(() => (window as any).fixture.permission("other-child", true))
    await page.waitForFunction(() => document.querySelector('[data-session-id="other"] .session-child-activity')?.getAttribute("data-child-activity") === "permission")
    assert.equal(await dot("other").getAttribute("title"), "1 subsession needs input, 1 subsession working")
    const colors = await dot("other").locator(".status-dot").evaluate(el => getComputedStyle(el).backgroundColor)
    assert.notEqual(colors, "rgba(0, 0, 0, 0)")
    if (process.env.CODENOMAD_CHILD_ACTIVITY_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_CHILD_ACTIVITY_CAPTURE })

    // Expanding hands the information to the child rows themselves.
    await page.locator('[data-session-id="other"] .session-item-expander').click()
    await page.locator('[data-session-id="other-child"]').waitFor()
    assert.equal(await dot("other").count(), 0)
    assert.equal(await dot("other-child").count(), 1)

    // A subsession of the viewed conversation is revealed below it.
    await page.evaluate(() => (window as any).fixture.status("work-child", "working"))
    await page.locator('[data-session-id="work-child"]').waitFor()
    assert.deepEqual((await rows()).slice(0, 2), ["work", "work-child"])
    assert.deepEqual(await page.locator('[data-session-id="work"]').boundingBox(), workBox)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
