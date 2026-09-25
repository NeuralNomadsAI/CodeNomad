import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "system-fixture", configureServer(s) {
      s.middlewares.use("/system-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/system-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/system-messages.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/system-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })
async function open(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.getByText("Normal assistant response", { exact: true }).waitFor()
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}
const system = '[data-message-kind="system"]'
async function toggleSystemDisclosure(page: Page) {
  await page.locator(system).getByRole("button").focus()
  await page.keyboard.press("Enter")
}
test("system context is hidden by default, including live instructions and reloads", async () => open(async page => {
  assert.equal(await page.locator(system).count(), 0)
  assert.equal(await page.getByText(/Today's date is now/).count(), 0)
  assert.equal((await page.evaluate(() => (window as any).fixture.matches())).length, 0)
  await page.evaluate(() => (window as any).fixture.live())
  await page.waitForFunction(() => (window as any).fixture.snapshot().ids.length === 4)
  assert.equal(await page.locator(system).count(), 0)
  await page.evaluate(() => (window as any).fixture.reload())
  assert.equal(await page.locator(system).count(), 0)
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).ids.length, 3)
}))

test("popup controls preserve content, synchronize Chat settings, and survive reopening", async () => open(async page => {
  for (const [label, icon] of [["System", "info"], ["shell", "terminal"], ["read", "book-open"],
    ["glob", "search"], ["Other", "layout-grid"]] as const) {
    const settingsRow = page.locator("#chat-settings .settings-expansion-row").filter({ hasText: label })
    assert.equal(await settingsRow.locator(`svg.lucide-${icon}`).count(), 1, `${label} uses the shared content icon`)
  }
  await page.getByRole("button", { name: "Message content", exact: true }).click()
  const row = page.getByRole("group", { name: "System", exact: true })
  await row.getByRole("button", { name: "Show System", exact: true }).click()
  await page.locator(system).waitFor()
  assert.equal(await page.locator(`${system} pre`).count(), 0)
  assert.equal(await page.locator(`${system} [data-message-role="assistant"]`).count(), 0)
  assert.equal(await page.locator(system).getByRole("button", { name: /Fork|Copy|Speak/ }).count(), 0)
  assert.equal((await page.evaluate(() => (window as any).fixture.matches())).length, 1)
  await row.getByRole("button", { name: "Expand System", exact: true }).click()
  const content = page.locator(`${system} pre`)
  await content.waitFor()
  assert.equal(await content.textContent(), (await page.evaluate(() => (window as any).fixture.snapshot())).nativeText)
  await page.keyboard.press("Escape")
  assert.equal(await page.locator('#chat-settings .settings-expansion-row').filter({ hasText: "System" }).locator(".selector-trigger-primary").textContent(), "Expanded")
  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await page.locator(`${system} pre`).waitFor()
  await page.getByRole("button", { name: "Message content", exact: true }).click()
  await row.getByRole("button", { name: "Hide System", exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[data-message-kind="system"]'))
  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).fixture))
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).visibility, "hidden")
  assert.equal(await page.locator(system).count(), 0)
}))

test("visible live notices render as System and obey local and global disclosure", async () => open(async page => {
  await page.getByRole("button", { name: "Message content", exact: true }).click()
  const row = page.getByRole("group", { name: "System", exact: true })
  await row.getByRole("button", { name: "Show System", exact: true }).click()
  await page.keyboard.press("Escape")
  await page.evaluate(() => (window as any).fixture.live())
  await page.waitForFunction(() => document.querySelectorAll('[data-message-kind="system"]').length === 2)
  const live = page.locator(system).filter({ hasText: "Instructions updated" })
  await live.getByRole("button").click()
  assert.equal(await live.locator("pre").textContent(), "Live system context")
  await page.getByRole("button", { name: "Message content", exact: true }).click()
  await row.getByRole("button", { name: "Expand System", exact: true }).click()
  await row.getByRole("button", { name: "Collapse System", exact: true }).click()
  assert.equal(await page.locator(`${system} pre`).count(), 0)
}))

test("search highlights system occurrences and restores highlights after disclosure changes", async () => open(async page => {
  await page.getByRole("button", { name: "Message content", exact: true }).click()
  const row = page.getByRole("group", { name: "System", exact: true })
  await row.getByRole("button", { name: "Show System", exact: true }).click()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Control+f")
  await page.getByPlaceholder("Search current chat...").fill("system-reminder")
  await page.locator(`${system} mark.session-search-match-active`).waitFor()
  assert.equal(await page.locator(`${system} mark.session-search-match`).count(), 2)
  await toggleSystemDisclosure(page)
  assert.equal(await page.locator(`${system} pre`).count(), 0)
  await toggleSystemDisclosure(page)
  await page.locator(`${system} pre`).waitFor({ timeout: 5000 })
  await page.locator(`${system} mark.session-search-match-active`).waitFor({ timeout: 5000 })
  assert.equal(await page.locator(`${system} mark.session-search-match-active`).count(), 1)
  await toggleSystemDisclosure(page)
  await toggleSystemDisclosure(page)
  await page.locator(`${system} mark.session-search-match-active`).waitFor({ timeout: 5000 })
}))

test("search refreshes on system visibility changes and still finds assistant text", async () => open(async page => {
  await page.keyboard.press("Control+f")
  const query = page.getByPlaceholder("Search current chat...")
  await query.fill("Today's date")
  await page.getByText("No matches", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Message content", exact: true }).click()
  const row = page.getByRole("group", { name: "System", exact: true })
  await row.getByRole("button", { name: "Show System", exact: true }).click()
  await page.locator(`${system} mark.session-search-match-active`).waitFor()
  await row.getByRole("button", { name: "Hide System", exact: true }).click()
  await page.keyboard.press("Escape")
  await page.getByText("No matches", { exact: true }).waitFor()
  assert.equal(await page.locator(system).count(), 0)
  await query.fill("Normal assistant")
  await page.locator("mark.session-search-match-active").waitFor()
  assert.equal(await page.locator("mark.session-search-match-active").textContent(), "Normal assistant")
  assert.ok((await page.evaluate(() => (window as any).fixture.snapshot())).messageReads < 10,
    "paging must not subscribe the search effect to its own window mutations")
}))
