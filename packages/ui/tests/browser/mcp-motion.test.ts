import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "mcp-motion",
      routes: [
        { path: "/mcp-motion", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mcp-motion.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); })

async function withFixture(motion: "reduce" | "no-preference", run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 700, height: 850 }, deviceScaleFactor: 1.5, reducedMotion: motion, locale: "en-US" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForFunction(() => Boolean((window as any).mcpFixture), undefined, { timeout: 30_000 })
    await page.locator(".status-dot").first().waitFor()
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}

async function perpetualAnimations(page: Page) {
  return page.evaluate(() => document.getAnimations().filter(animation =>
    animation.playState === "running" && animation.effect?.getComputedTiming().iterations === Infinity,
  ).length)
}

for (const motion of ["no-preference", "reduce"] as const) {
  test(`eight connected MCP servers stay static at rest (${motion}, 150% scale)`, () => withFixture(motion, async page => {
    assert.equal(await page.locator(".status-dot.ready").count(), 8)
    assert.equal(await page.getByRole("checkbox").count(), 8)
    assert.equal(await perpetualAnimations(page), 0, "connected servers must not schedule perpetual animation frames")
    // Witnesses for the shared rule: CSS animations on an SVG and its child stay inert.
    assert.equal(await page.evaluate(() => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      const style = document.createElement("style")
      style.textContent = "@keyframes svg-witness { to { opacity: 0.5 } }"
      svg.style.animation = path.style.animation = "svg-witness 1s"
      path.setAttribute("d", "M0 0h4")
      svg.append(path); document.body.append(style, svg)
      const running = document.getAnimations().filter(a => (a.effect as KeyframeEffect | null)?.target instanceof SVGElement).length
      svg.remove(); style.remove()
      return running
    }), 0, "SVG icons never animate")
    assert.deepEqual(await page.evaluate(() => (window as any).mcpFixture.calls), [])
    const header = page.locator(".right-panel-accordion-trigger")
    await header.click()
    await page.locator(".status-dot").first().waitFor({ state: "hidden" })
    assert.equal(await perpetualAnimations(page), 0)
    await header.click()
    await page.locator(".status-dot").first().waitFor()
    assert.equal(await page.locator(".status-dot.ready").count(), 8)
    assert.equal(await perpetualAnimations(page), 0)
  }))

  test(`MCP operation feedback stops on success and failure (${motion})`, () => withFixture(motion, async page => {
    const toggle = page.getByRole("checkbox", { name: "Toggle dnd-5e MCP server", exact: true })
    const pendingIcon = page.locator(".lucide-loader2")
    assert.equal(await toggle.isChecked(), true)
    await toggle.click()
    await pendingIcon.waitFor()
    assert.equal(await toggle.isDisabled(), true)
    assert.equal(await perpetualAnimations(page), 0, "the pending dot and loading icon stay static")
    await page.evaluate(() => (window as any).mcpFixture.settle())
    await pendingIcon.waitFor({ state: "detached" })
    assert.equal(await toggle.isChecked(), false)
    assert.equal(await toggle.isEnabled(), true)
    assert.equal(await perpetualAnimations(page), 0)
    await toggle.click()
    await pendingIcon.waitFor()
    await page.evaluate(() => (window as any).mcpFixture.settle(true))
    await pendingIcon.waitFor({ state: "detached" })
    assert.equal(await toggle.isChecked(), false)
    assert.equal(await toggle.isEnabled(), true)
    assert.equal(await perpetualAnimations(page), 0)
    await toggle.click()
    await pendingIcon.waitFor()
    await page.evaluate(() => (window as any).mcpFixture.settle())
    await pendingIcon.waitFor({ state: "detached" })
    assert.equal(await toggle.isChecked(), true)
    assert.equal(await page.locator(".status-dot.ready").count(), 8)
    assert.equal(await perpetualAnimations(page), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).mcpFixture.calls), Array(3).fill({ server: "dnd-5e", location: { directory: "/fixture" } }))
    await page.evaluate(() => (window as any).mcpFixture.setStatus("serena", "failed"))
    await page.getByText("Fixture server failed", { exact: true }).waitFor()
    assert.equal(await page.locator(".status-dot.error").count(), 1)
    assert.equal(await perpetualAnimations(page), 0)
  }))
}
