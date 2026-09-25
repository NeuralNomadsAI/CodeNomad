import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "fork-fixture", configureServer(s) {
      s.middlewares.use("/fork-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fork-fixture", '<html><body><div id="root" style="display:flex;height:700px;width:1100px"></div><script type="module" src="/tests/browser/fixtures/fork.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fork-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

for (const [id, count, beforeID] of [["msg_01", 1, "msg_02"], ["msg_02", 2, "msg_03"], ["msg_04", 4, undefined]] as const) {
  test(`fork after ${id} includes the selection and opens an empty composer`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
      await page.goto(url)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      await page.locator("textarea:visible").first().fill("Keep this draft in the source")
      const row = page.locator(`[data-view="message-item"][data-message-id="${id}"]`)
      await row.hover()
      await row.getByRole("button", { name: "Fork after this message", exact: true }).click()
      await page.waitForFunction(() => (window as any).fixture.snapshot().active === "fork")
      await page.waitForFunction(() => document.querySelector('[data-session-id="fork"][data-view="message-item"]'))
      assert.equal(await page.locator("textarea:visible").first().inputValue(), "")
      const state = await page.evaluate(() => (window as any).fixture.snapshot())
      assert.equal(state.fork.length, count)
      assert.equal(state.sourceCount, 4)
      assert.equal(state.prompts, 0)
      assert.deepEqual(state.requests, [{ sessionID: "source", ...(beforeID ? { before: beforeID } : {}) }])
      await page.evaluate(() => (window as any).fixture.source())
      await page.waitForFunction(() => document.querySelector('[data-session-id="source"][data-view="message-item"]'))
      assert.equal(await page.locator("textarea:visible").first().inputValue(), "Keep this draft in the source")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("an unfinished assistant response does not offer Fork", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(`${url}?streaming`)
    const row = page.locator('[data-view="message-item"][data-message-id="msg_04"]')
    await row.waitFor()
    assert.equal(await row.getByRole("button", { name: "Fork after this message", exact: true }).count(), 0)
  } finally { await page.close() }
})

test("assistant Fork remains available in the narrow overflow menu", async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 }, locale: "en-US" })
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(url)
    await page.evaluate(() => { document.getElementById("root")!.style.width = "200px" })
    const row = page.locator('[data-view="message-item"][data-message-id="msg_02"]')
    await row.waitFor()
    await row.hover()
    await row.getByRole("button", { name: "More actions", exact: true }).click()
    await page.getByRole("menuitem", { name: "Fork after this message", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.snapshot().active === "fork")
    assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).fork.length, 2)
  } finally { await page.close() }
})
