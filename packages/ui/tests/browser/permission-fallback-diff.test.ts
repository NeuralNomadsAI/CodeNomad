import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "permission-fallback-fixture", configureServer(s) {
      s.middlewares.use("/permission-fallback-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/permission-fallback-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/permission-fallback-diff.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/permission-fallback-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function openFixture(page: Page, clipboard: "success" | "failure" | "pending") {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  // Use source text: tsx's function-name helpers are not present in the browser realm.
  await page.addInitScript(`{
    const mode = ${JSON.stringify(clipboard)};
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => {
      window.copied = text
      if (mode === "failure") throw new Error("Clipboard denied")
      if (mode === "pending") await new Promise(resolve => { window.finishCopy = resolve })
    } } })
    document.execCommand = () => false
  }`)
  await page.goto(url)
  await page.getByRole("button", { name: "Copy patch", exact: true }).waitFor()
  await page.waitForFunction(() => Boolean((window as any).fixture))
  assert.deepEqual(errors, [], "fixture must initialize without browser errors")
}

test("source-less modal diff is complete through bounded pages even when clipboard fails", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await openFixture(page, "failure")
    const allow = page.getByRole("button", { name: "Allow Once", exact: true })
    const always = page.getByRole("button", { name: "Always Allow", exact: true })
    assert.equal(await allow.isDisabled(), true)
    assert.equal(await always.isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: "Deny", exact: true }).isEnabled(), true)
    await page.getByRole("button", { name: "Copy patch", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "Copy failed" }).waitFor()
    assert.equal(await allow.isDisabled(), true)
    const chunks: string[] = []
    const next = page.getByRole("button", { name: "Next diff page", exact: true })
    for (;;) {
      const chunk = await page.locator(".tool-call-diff-fallback").textContent() ?? ""
      assert.ok(chunk.length <= 10_000)
      chunks.push(chunk)
      if (await next.isDisabled()) break
      assert.equal(await allow.isDisabled(), true)
      await next.click()
    }
    assert.equal(chunks.join(""), await page.evaluate(() => (window as any).fixture.diff))
    assert.equal(await allow.isEnabled(), true)
    assert.equal(await always.isEnabled(), true)
    await page.evaluate(() => (window as any).fixture.refresh())
    assert.equal(await allow.isEnabled(), true)
    await allow.click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.replies), [{ sessionID: "session", requestID: "request", decision: "once" }])
  } finally { await page.close() }
})

test("full copy unlocks both approvals only for the same request and unchanged diff", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await openFixture(page, "success")
    const allow = page.getByRole("button", { name: "Allow Once", exact: true })
    const copy = page.getByRole("button", { name: "Copy patch", exact: true })
    await copy.click()
    assert.equal(await page.evaluate(() => (window as any).copied === (window as any).fixture.diff), true)
    assert.equal(await allow.isEnabled(), true)
    await page.evaluate(() => (window as any).fixture.refresh())
    assert.equal(await allow.isEnabled(), true)
    await page.evaluate(() => (window as any).fixture.changeDiff())
    assert.equal(await allow.isDisabled(), true)
    await copy.click()
    assert.equal(await allow.isEnabled(), true)
    await page.evaluate(() => (window as any).fixture.nextRequest())
    assert.equal(await allow.isDisabled(), true)
    await copy.click()
    await page.getByRole("button", { name: "Always Allow", exact: true }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.replies), [{ sessionID: "session", requestID: "next-request", decision: "always" }])
  } finally { await page.close() }
})

test("late clipboard success cannot unlock a changed diff or a dismissed view", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await openFixture(page, "pending")
    const copy = page.getByRole("button", { name: "Copy patch", exact: true })
    await copy.click()
    await page.evaluate(() => (window as any).fixture.changeDiff())
    await page.evaluate(() => (window as any).finishCopy())
    assert.equal(await page.getByRole("button", { name: "Allow Once", exact: true }).isDisabled(), true)
    await copy.click()
    await page.keyboard.press("Escape")
    await page.evaluate(() => (window as any).finishCopy())
    await page.evaluate(() => (window as any).fixture.reopen())
    assert.equal(await page.getByRole("button", { name: "Allow Once", exact: true }).isDisabled(), true)
  } finally { await page.close() }
})
