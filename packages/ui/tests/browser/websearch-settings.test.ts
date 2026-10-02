import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "web-settings-fixture", configureServer(s) { s.middlewares.use("/fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/websearch-settings.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })
test("web settings use explicit scopes, native keys, no mutation replay and fence late writes", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 1000 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(`${url}?project`)
    // All websearch controls live in Settings, never in Status.
    assert.equal(await page.getByLabel("Default search", { exact: true }).count(), 0)
    assert.equal(await page.getByLabel("For the current project", { exact: true }).count(), 0)
    assert.equal(await page.getByText("Search provider API keys", { exact: true }).count(), 0)
    await page.goto(url)
    await page.getByLabel("For the current project", { exact: true }).selectOption("off")
    await page.waitForFunction(() => document.querySelector('select[title="Search in this project: Disabled"]'))
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes), [{ location: { directory: "/a" }, scope: "project", provider: false }])
    await page.evaluate(() => (window as any).fixture.reject())
    await page.getByLabel("For the current project", { exact: true }).selectOption("default")
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByLabel("For the current project", { exact: true }).inputValue(), "off")
    assert.equal((await page.evaluate(() => (window as any).fixture.writes)).length, 2)
    await page.evaluate(() => (window as any).fixture.setDirectory("/b"))
    await page.waitForFunction(() => document.querySelector('select[title="Search in this project: Alpha"]'))
    assert.equal(await page.getByLabel("For the current project", { exact: true }).inputValue(), "default")
    await page.goto(url)
    await page.getByLabel("Default search", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("For the current project", { exact: true }).count(), 1)
    assert.equal(await page.getByText("Search in this project: Alpha", { exact: true }).count(), 0)
    await page.locator(".websearch-provider-connections .providers-connect-select").waitFor()
    assert.equal(await page.locator("summary").count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.integrationLists()), 1)
    assert.equal(await page.getByLabel("API key", { exact: true }).count(), 0)
    await page.getByRole("button", { name: "Connect", exact: true }).click()
    await page.getByLabel("API key", { exact: true }).fill("fixture-secret")
    await page.locator(".providers-connect-panel").getByRole("button", { name: "Connect", exact: true }).click()
    await page.getByLabel("API key", { exact: true }).waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.keys), [{ integrationID: "alpha", key: "fixture-secret", location: { directory: "/a" } }])
    assert.match(await page.locator(".websearch-provider-connections .providers-connect-select").innerText(), /Alpha/)
    assert.equal(await page.getByLabel("Default search", { exact: true }).inputValue(), "provider:alpha")
    assert.match(await page.locator(".providers-card-meta").innerText(), /From environment: ALPHA_API_KEY \(read-only\)/)
    await page.getByRole("button", { name: "Remove saved auth: Alpha — Saved key", exact: true }).first().click()
    await page.waitForFunction(() => (window as any).fixture.keys.length === 2)
    assert.deepEqual((await page.evaluate(() => (window as any).fixture.keys))[1], { credentialID: "key-id" })
    if (process.env.CODENOMAD_WEB_SETTINGS_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_WEB_SETTINGS_CAPTURE, fullPage: true })
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true,
      JSON.stringify(await page.locator("main").evaluate(el => [...el.querySelectorAll("*")].filter(child => child.getBoundingClientRect().right > el.getBoundingClientRect().right).map(child => [child.tagName, child.className, child.getBoundingClientRect().width]))))
    await page.evaluate(() => (window as any).fixture.hold())
    await page.getByLabel("Default search", { exact: true }).selectOption("provider:random")
    await page.evaluate(() => (window as any).fixture.setDirectory("/b"))
    await page.waitForFunction(() => (document.querySelector('select[aria-label="Default search"]') as HTMLSelectElement)?.value === "provider:alpha")
    await page.evaluate(() => (window as any).fixture.release())
    assert.equal(await page.getByLabel("Default search", { exact: true }).inputValue(), "provider:alpha")
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error(errors, await page.locator("body").innerText())
    throw error
  } finally { await page.close() }
})

test("Providers separates Models and Web search with shared row and input styling", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(`${url}?preview`)
    await page.getByRole("heading", { name: "Models", exact: true }).waitFor()
    await page.getByRole("heading", { name: "Web search", exact: true }).waitFor()
    assert.equal(await page.getByRole("heading", { name: "Configured Providers", exact: true }).count(), 0)
    await page.locator(".providers-card-title").filter({ hasText: "OpenAI" }).waitFor()
    assert.equal(await page.getByRole("region", { name: "Models", exact: true }).getByRole("heading", { name: "Alpha", exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.integrationLists()), 2)
    const search = page.getByRole("region", { name: "Web search", exact: true })
    await search.getByRole("button", { name: "Connect", exact: true }).click()
    await page.getByLabel("API key", { exact: true }).waitFor()
    assert.equal(await search.evaluate(el => {
      const list = el.querySelector(".providers-list-section")!
      const defaults = el.querySelector(".websearch-settings-defaults")!
      return Boolean(list.compareDocumentPosition(defaults) & Node.DOCUMENT_POSITION_FOLLOWING)
    }), true)
    for (const width of [900, 380]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("search connection failures are not replayed and late replies preserve the new context's draft", async () => {
  const page = await browser.newPage({ viewport: { width: 700, height: 1000 }, locale: "en-US" })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    const connect = page.locator(".providers-connect-bar").getByRole("button", { name: "Connect", exact: true })
    const submit = page.locator(".providers-connect-panel").getByRole("button", { name: "Connect", exact: true })
    await connect.click()
    await page.getByLabel("API key", { exact: true }).fill("failed-fixture-key")
    await page.evaluate(() => (window as any).fixture.reject())
    await submit.click()
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "failed-fixture-key")
    assert.equal((await page.evaluate(() => (window as any).fixture.keys)).length, 1)
    assert.equal((await page.evaluate(() => (window as any).fixture.writes)).length, 0)

    await page.evaluate(() => (window as any).fixture.hold())
    await submit.click()
    await page.evaluate(() => (window as any).fixture.setDirectory("/b"))
    await page.getByLabel("API key", { exact: true }).waitFor({ state: "detached" })
    await connect.click()
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "")
    await page.getByLabel("API key", { exact: true }).fill("new-context-draft")
    await page.evaluate(() => (window as any).fixture.release())
    // Let the old promise settle before checking the still-open new form.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "new-context-draft")
    assert.equal((await page.evaluate(() => (window as any).fixture.keys)).length, 2)
  } finally { await page.close() }
})
