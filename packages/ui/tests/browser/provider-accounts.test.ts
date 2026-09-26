import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "accounts-fixture", configureServer(s) { s.middlewares.use("/fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/provider-accounts.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })
test("account identity drives activation, rename, removal and failed-edit preservation", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.getByText("Accounts", { exact: true }).click()
    const first = page.locator('[data-account-id="credential:one"]'), second = page.locator('[data-account-id="credential:two"]')
    await first.getByText("Active", { exact: true }).waitFor()
    assert.equal(await page.locator('[data-account-id="env:PROVIDER_KEY"] button').count(), 0)
    await second.getByRole("button", { name: "Use account" }).click()
    await second.getByText("Active", { exact: true }).waitFor()
    assert.equal(await first.getByLabel("Account label").count(), 0)
    await first.getByRole("button", { name: "Rename account", exact: true }).click()
    await first.getByLabel("Account label").fill("New name")
    await page.evaluate(() => (window as any).fixture.refresh())
    assert.equal(await first.getByLabel("Account label").inputValue(), "New name")
    await page.evaluate(() => (window as any).fixture.fail())
    await first.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(await first.getByLabel("Account label").inputValue(), "New name")
    assert.equal((await page.evaluate(() => (window as any).fixture.writes)).length, 2)
    await first.getByRole("button", { name: "Save", exact: true }).click()
    await first.getByText("New name", { exact: true }).waitFor()
    if (process.env.CODENOMAD_ACCOUNTS_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_ACCOUNTS_CAPTURE, fullPage: true })
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await first.getByRole("button", { name: "Remove account", exact: true }).click()
    await first.waitFor({ state: "detached" })
    assert.equal(await second.count(), 1)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes), [
      { action: "activate", credentialID: "two" }, { action: "rename", credentialID: "one", label: "New name" },
      { action: "rename", credentialID: "one", label: "New name" }, { action: "remove", credentialID: "one" },
    ])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("real provider manager retains other dirty labels and reconciles external activation", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(`${url}?parent`)
    await page.locator(".provider-accounts summary").getByText("First", { exact: true }).waitFor()
    assert.equal(await page.locator(".providers-card-meta, .provider-accounts p").count(), 0)
    await page.getByRole("button", { name: "Add account", exact: true }).click()
    await page.locator(".providers-connect-panel").waitFor()
    await page.locator(".providers-connect-panel").getByRole("button", { name: "Close", exact: true }).click()
    await page.getByText("Accounts", { exact: true }).click()
    const first = page.locator('[data-account-id="credential:one"]'), second = page.locator('[data-account-id="credential:two"]')
    await first.waitFor()
    if (process.env.CODENOMAD_ACCOUNTS_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_ACCOUNTS_CAPTURE.replace(".png", "-manager.png"), fullPage: true })
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await first.getByRole("button", { name: "Rename account", exact: true }).click()
    await second.getByRole("button", { name: "Rename account", exact: true }).click()
    await first.getByLabel("Account label").fill("Uncommitted first")
    await second.getByLabel("Account label").fill("Uncommitted second")
    await second.getByRole("button", { name: "Use account", exact: true }).click()
    await second.getByText("Active", { exact: true }).waitFor()
    await page.waitForFunction(() => (window as any).fixture.reads() >= 4)
    assert.equal(await first.getByLabel("Account label").inputValue(), "Uncommitted first")
    assert.equal(await second.getByLabel("Account label").inputValue(), "Uncommitted second")
    await page.evaluate(() => (window as any).fixture.switchExternally())
    await first.getByText("Active", { exact: true }).waitFor()
    assert.equal(await first.getByLabel("Account label").inputValue(), "Uncommitted first")
    await first.getByLabel("Account label").fill("Saved label")
    await page.evaluate(() => (window as any).fixture.deferParent())
    await first.getByRole("button", { name: "Save", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.parentPending())
    await first.getByLabel("Account label").fill("Newer draft")
    await page.evaluate(() => (window as any).fixture.releaseParent())
    await page.waitForFunction(() => !document.querySelector(".providers-loading-row"))
    assert.equal(await first.getByLabel("Account label").inputValue(), "Newer draft")
    assert.equal(await first.getByRole("button", { name: "Save", exact: true }).isEnabled(), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
