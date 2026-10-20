import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
const captures = fileURLToPath(new URL("../../../../.tmp/message-tokens/", import.meta.url))
before(async () => {
  await mkdir(captures, { recursive: true })
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, locale: "en-US", reducedMotion: "reduce" })
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
  assert.equal(await page.locator('[data-message-id="msg_03"] .message-step-usage-toggle .message-step-usage-chip').count(), 3)
  assert.equal(await page.locator('[data-message-id="msg_03"] .message-step-usage-content').count(), 0)
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
  assert.equal(await page.locator('[data-message-id="msg_03"] .message-step-usage-toggle .message-step-usage-chip').count(), 0)
  assert.equal(await page.locator('[data-message-id="msg_03"] .message-step-usage-content .message-step-usage-chip').count(), 6)
  assert.equal(await page.locator('[data-message-id="msg_03"] .message-step-usage-toggle').textContent(), "Tokens")
}))

test("the Tokens filter hides, collapses and expands every usage line", async () => open(async page => {
  await usageLines(page).first().waitFor()
  await page.getByRole("button", { name: "Message content", exact: true }).click()
  const row = page.getByRole("group", { name: "Tokens", exact: true })
  await row.getByRole("button", { name: "Expand Tokens", exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll(".message-step-usage-chip").length === 12)
  await row.getByRole("button", { name: "Hide Tokens", exact: true }).click()
  await page.waitForFunction(() => !document.querySelector(".message-step-usage-toggle"))
  assert.equal(await page.locator(".message-step-usage-chip, .message-step-usage-content").count(), 0)
  await page.getByText("There are three files", { exact: true }).waitFor()
  await row.getByRole("button", { name: "Show Tokens", exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll(".message-step-usage-toggle").length === 2)
}))

test("message token headers ellipsize at narrow widths and disclose content without duplicates using Enter/Space, including RTL", async () => open(async page => {
  const message = page.locator('.message-stream-block[data-message-id="msg_03"]')
  const toggle = message.locator(".message-step-usage-toggle")
  for (const [name, width, direction] of [["desktop", 900, "ltr"], ["narrow", 220, "ltr"], ["narrow-rtl", 220, "rtl"]] as const) {
    await page.evaluate(({ width, direction }) => {
      (window as any).fixture.width(width)
      document.querySelector("[data-usage-fixture]")!.setAttribute("dir", direction)
    }, { width, direction })
    await toggle.waitFor()
    assert.deepEqual(await chips(page, "msg_03"), ["Input 1K", "Output 12", "Cost $0.50"])
    assert.equal(await toggle.locator(".message-step-usage-chip").count(), 3)
    assert.equal(await toggle.locator("button").count(), 0)
    assert.match(await toggle.getAttribute("aria-label") ?? "", /Input: 1300, Output: 12, Cost: \$0.50/)
    await message.screenshot({ path: `${captures}/${name}-collapsed.png` })
    const geometry = await toggle.evaluate(element => {
      const summary = element.querySelector<HTMLElement>(".message-step-usage-summary")!
      const chevron = element.querySelector(".disclosure-chevron")!.getBoundingClientRect()
      const button = element.getBoundingClientRect()
      return { overflow: element.scrollWidth > element.clientWidth, truncated: summary.scrollWidth > summary.clientWidth,
        ellipsis: getComputedStyle(summary).textOverflow, whiteSpace: getComputedStyle(summary).whiteSpace,
        buttonWidth: button.width, summaryWidth: summary.clientWidth, summaryScrollWidth: summary.scrollWidth,
        chevronInside: chevron.left >= button.left && chevron.right <= button.right }
    })
    assert.equal(geometry.overflow, false)
    assert.equal(geometry.ellipsis, "ellipsis")
    assert.equal(geometry.whiteSpace, "nowrap")
    assert.equal(geometry.chevronInside, true)
    if (width === 220) assert.equal(geometry.truncated, true, JSON.stringify(geometry))
    await toggle.focus()
    await page.keyboard.press("Enter")
    assert.equal(await toggle.getAttribute("aria-expanded"), "true")
    assert.equal(await toggle.locator(".message-step-usage-chip, .message-step-usage-summary").count(), 0)
    assert.equal(await toggle.textContent(), "Tokens")
    const content = message.locator(".message-step-usage-content")
    assert.equal(await content.getAttribute("id"), await toggle.getAttribute("aria-controls"))
    assert.deepEqual(await chips(page, "msg_03"), ["Input 1K", "Output 12", "Reasoning 5", "Cache Read 800", "Cache Write 16", "Cost $0.50"])
    assert.equal(await content.locator(".message-step-usage-chip").count(), 6)
    assert.equal(await content.evaluate(element => element.scrollWidth > element.clientWidth), false)
    await message.screenshot({ path: `${captures}/${name}-expanded.png` })
    await page.keyboard.press("Space")
    assert.equal(await toggle.getAttribute("aria-expanded"), "false")
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true)
    assert.equal(await content.count(), 0)
  }
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
