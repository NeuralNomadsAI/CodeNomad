import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({
      configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "usage-metrics", configureServer(s) {
        s.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/usage-metrics.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

async function open(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.getByText("There are three files", { exact: true }).waitFor()
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}

const usageLines = (page: Page) => page.locator(".message-step-usage-toggle")
const chips = (page: Page, messageId: string) => page.locator(`[data-message-id="${messageId}"] .message-step-usage-chip`)
  .evaluateAll(nodes => nodes.map(node => `${node.getAttribute("data-label")} ${node.textContent}`))

test("each completed V2 step shows its own compact token and cost line", async () => open(async page => {
  await usageLines(page).first().waitFor()
  assert.equal(await usageLines(page).count(), 2, "one line per completed assistant step, none for the idle record")
  assert.deepEqual(await chips(page, "msg_02"), ["Input 1K", "Output 34", "Cost $0.01"])
  assert.deepEqual(await chips(page, "msg_03"), ["Input 1K", "Output 12", "Cost $0.50"])
  assert.equal(await page.locator('[data-message-id="msg_02"] .message-step-usage-toggle').getAttribute("aria-expanded"), "false")
  // The line keeps the former step-finish geometry: flush under its step, no
  // block borders, and a message border only when it follows text, not tools.
  const geometry = (messageId: string) => page.locator(`[data-message-id="${messageId}"] .message-step-finish`).evaluate(element => {
    const style = getComputedStyle(element)
    return [style.marginTop, style.marginBottom, style.paddingTop, style.borderTopWidth, style.borderBottomWidth, style.borderLeftWidth]
  })
  assert.deepEqual(await geometry("msg_03"), ["-2px", "0px", "0px", "0px", "0px", "1px"])
  assert.deepEqual(await geometry("msg_02"), ["-2px", "0px", "0px", "0px", "0px", "0px"])

  await page.locator('[data-message-id="msg_03"] .message-step-usage-toggle').click()
  assert.deepEqual(await chips(page, "msg_03"), [
    "Input 1K", "Output 12", "Reasoning 5", "Cache Read 800", "Cache Write 16", "Cost $0.50",
  ])
  assert.equal(await page.locator('[data-message-id="msg_03"] .message-step-usage-toggle').getAttribute("aria-expanded"), "true")
}))

test("the Tokens filter hides, collapses and expands every usage line", async () => open(async page => {
  await usageLines(page).first().waitFor()
  await page.getByRole("button", { name: "Message content", exact: true }).click()
  const row = page.getByRole("group", { name: "Tokens", exact: true })
  await row.getByRole("button", { name: "Expand Tokens", exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll(".message-step-usage-chip").length === 12)
  await row.getByRole("button", { name: "Hide Tokens", exact: true }).click()
  await page.waitForFunction(() => !document.querySelector(".message-step-usage-toggle"))
  await page.getByText("There are three files", { exact: true }).waitFor()
  await row.getByRole("button", { name: "Show Tokens", exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll(".message-step-usage-toggle").length === 2)
}))

test("a live step gains its usage line when native step settlement reports it", async () => open(async page => {
  await usageLines(page).first().waitFor()
  await page.evaluate(() => (window as any).fixture.startStep())
  await page.getByText("Live answer", { exact: true }).waitFor()
  assert.equal(await page.locator('[data-message-id="msg_live"] .message-step-usage-toggle').count(), 0, "no usage before the step ends")
  await page.evaluate(() => (window as any).fixture.endStep())
  await page.locator('[data-message-id="msg_live"] .message-step-usage-toggle').waitFor()
  assert.deepEqual(await chips(page, "msg_live"), ["Input 4K", "Output 99", "Cost $0.00"])
}))
