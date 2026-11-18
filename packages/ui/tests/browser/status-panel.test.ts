import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "status-panel",
      routes: [
        { path: "/status-fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/status-panel.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("Status comes first by default and its customization chevron folds sections without changing visibility", async () => {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.addInitScript(() => localStorage.setItem("opencode-session-right-panel-tab-v2", "status"))
  try {
    await page.goto(url)
    const metrics = page.locator(".status-token-summary")
    await metrics.locator(".usage-metric-chip").first().waitFor()
    assert.equal(await page.getByRole("tab").first().innerText(), "Status")
    await page.getByRole("button", { name: "Customize right panel", exact: true }).click()
    const popup = page.getByRole("group", { name: "Customize right panel", exact: true })
    const status = popup.getByRole("button", { name: "Status", exact: true })
    const tokens = popup.getByRole("checkbox", { name: "Tokens", exact: true })
    assert.equal(await popup.getByRole("checkbox", { name: "Status", exact: true }).count(), 0)
    assert.equal(await popup.locator(".right-panel-customization-row").first().innerText(), "Status")
    assert.equal(await status.getAttribute("aria-expanded"), "true")
    await tokens.waitFor()
    const before = await page.evaluate(() => (window as any).statusFixture.customization())
    const content = await metrics.elementHandle()
    const captures = process.env.CODENOMAD_STATUS_CAPTURE_DIR
    if (captures) {
      await mkdir(captures, { recursive: true })
      await popup.screenshot({ path: path.join(captures, "status-customization-expanded.png") })
    }
    await status.click()
    assert.equal(await status.getAttribute("aria-expanded"), "false")
    await tokens.waitFor({ state: "detached" })
    await popup.getByRole("checkbox", { name: "Files", exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).statusFixture.customization()), before,
      "folding does not hide any tab or section")
    assert.equal(await content!.evaluate(element => element.isConnected), true, "the displayed Status section stays mounted")
    assert.equal(await metrics.locator(".usage-metric-chip").first().isVisible(), true)
    if (captures) await popup.screenshot({ path: path.join(captures, "status-customization-collapsed.png") })
    await page.keyboard.press("Space")
    assert.equal(await status.getAttribute("aria-expanded"), "true")
    await tokens.uncheck()
    await metrics.waitFor({ state: "detached" })
    await status.click()
    await page.keyboard.press("Enter")
    assert.equal(await tokens.isChecked(), false, "folding preserves section choices")
    await tokens.check()
    await metrics.locator(".usage-metric-chip").first().waitFor()
    await page.keyboard.press("Escape")
    assert.equal(await page.getByRole("tab", { name: "Status", exact: true }).isVisible(), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a saved right-panel tab order takes precedence over the Status-first default", async () => {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, locale: "en-US" })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.addInitScript(() => localStorage.setItem("opencode-session-right-panel-customization-v1", JSON.stringify({ tabOrder: ["files", "status"] })))
  try {
    await page.goto(url)
    await page.getByRole("tab", { name: "Status", exact: true }).waitFor()
    assert.equal(await page.getByRole("tab").first().innerText(), "Files")
    await page.getByRole("button", { name: "Customize right panel", exact: true }).click()
    const popup = page.getByRole("group", { name: "Customize right panel", exact: true })
    assert.equal(await popup.locator(".right-panel-customization-row").first().innerText(), "Files")
    assert.equal(await popup.getByRole("button", { name: "Status", exact: true }).getAttribute("aria-expanded"), "true")
  } finally { await page.close() }
})

test("Status tokens use the message chips and expand in the header line, wrapping in narrow LTR and RTL panels", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, locale: "en-US", reducedMotion: "reduce" })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.addInitScript(() => localStorage.setItem("opencode-session-right-panel-tab-v2", "status"))
  try {
    await page.goto(url)
    const section = page.locator('[data-status-section="tokens"]')
    const toggle = section.locator(".right-panel-accordion-trigger")
    const metrics = section.locator(".status-token-summary")
    await metrics.locator(".usage-metric-chip").first().waitFor()
    const values = () => metrics.locator(".usage-metric-chip").evaluateAll(chips => chips.map(chip => [chip.getAttribute("data-label"), chip.textContent!.trim()]))
    const expected = [["Input", "1K"], ["Output", "300"], ["Cost", "$0.12"]]
    for (const [width, direction] of [[600, "ltr"], [220, "ltr"], [220, "rtl"]] as const) {
      await page.evaluate(({ width, direction }) => {
        (window as any).statusFixture.width(width)
        document.querySelector("[data-status-fixture]")!.setAttribute("dir", direction)
      }, { width, direction })
      await page.waitForFunction(width => document.querySelector('[data-status-section="tokens"]')!.getBoundingClientRect().width <= width, width)
      if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click()
      assert.deepEqual(await values(), expected)
      assert.equal(await metrics.evaluate(element => getComputedStyle(element).textOverflow), "ellipsis")
      // Both displays use the same real metric component and stylesheet, including the labels.
      const style = (selector: string) => page.locator(selector).first().evaluate(element => {
        const chip = getComputedStyle(element), label = getComputedStyle(element, "::before")
        return [chip.fontSize, chip.fontWeight, chip.color, chip.borderColor, chip.minHeight, label.fontSize, label.textTransform]
      })
      assert.deepEqual(await style(".status-token-summary .usage-metric-chip"), await style(".message-step-usage-chip"))
      await toggle.focus()
      await page.keyboard.press("Enter")
      assert.deepEqual(await values(), [expected[0], expected[1], ["Reasoning", "80"], expected[2]])
      const geometry = await toggle.evaluate(element => {
        const bounds = element.getBoundingClientRect(), label = element.querySelector(".section-left")!.getBoundingClientRect()
        const chips = [...element.querySelectorAll(".usage-metric-chip")].map(chip => chip.getBoundingClientRect())
        return { width: bounds.width, sameLine: Math.abs(label.top - chips[0].top) <= 1,
          inside: chips.every(chip => chip.left >= bounds.left && chip.right <= bounds.right),
          rows: new Set(chips.map(chip => Math.round(chip.top))).size }
      })
      assert.equal(geometry.sameLine, true, JSON.stringify(geometry))
      assert.equal(geometry.inside, true, JSON.stringify(geometry))
      if (width === 220) assert.ok(geometry.rows > 1, JSON.stringify(geometry))
      const captures = process.env.CODENOMAD_STATUS_CAPTURE_DIR
      if (captures) await section.screenshot({ path: path.join(captures, `tokens-${width}-${direction}-expanded.png`) })
      await page.keyboard.press("Space")
      assert.deepEqual(await values(), expected)
    }
    await page.evaluate(() => (window as any).statusFixture.child())
    await toggle.click()
    const totals = section.locator('[data-token-group="thread"]')
    await totals.waitFor()
    assert.equal(await totals.locator(".usage-metric-chip").count(), 4, "descendant-inclusive totals stay available below the header")
    assert.equal(await section.locator('[data-token-group="session"]').count(), 0, "session metrics appear only in the header")
    const header = await metrics.elementHandle()
    await page.evaluate(() => (window as any).statusFixture.update())
    assert.equal(await header!.evaluate(element => element.isConnected), true, "session updates preserve the metric row")
  } finally { await page.close() }
})

test("Tokens can be collapsed, hidden and restored across reloads with legacy Plan customization", async () => {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.addInitScript(() => {
    localStorage.setItem("opencode-session-right-panel-tab-v2", "status")
    const key = "opencode-session-right-panel-customization-v1"
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      statusSectionOrder: ["plan", "yolo-mode", "provider-usage"], hiddenStatusSectionIds: ["plan"],
    }))
  })
  try {
    await page.goto(url)
    // Collapsed, the trigger's name also carries the compact token summary.
    const tokens = page.getByRole("button", { name: /^Tokens\b/ })
    const metrics = page.locator(".status-token-summary")
    await metrics.locator(".usage-metric-chip").first().waitFor()
    assert.equal(await page.getByRole("button", { name: "Plan", exact: true }).count(), 0)
    await tokens.click()
    assert.equal(await tokens.getAttribute("aria-expanded"), "false")
    assert.equal(await metrics.locator(".usage-metric-chip").count(), 3)
    await page.locator(".status-token-summary").waitFor()
    await tokens.click()
    await metrics.locator(".usage-metric-chip").first().waitFor()
    assert.equal(await metrics.locator(".usage-metric-chip").count(), 4)

    const customize = page.getByRole("button", { name: "Customize right panel", exact: true })
    await customize.click()
    assert.equal(await page.getByRole("checkbox", { name: "Plan", exact: true }).count(), 0)
    await page.getByRole("checkbox", { name: "Tokens", exact: true }).uncheck()
    await metrics.waitFor({ state: "detached" })
    assert.equal(await tokens.count(), 0)
    assert.ok(await page.evaluate(() => (window as any).statusFixture.customization().hiddenStatusSectionIds.includes("tokens")))

    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).statusFixture))
    assert.equal(await tokens.count(), 0)
    await customize.click()
    assert.equal(await page.getByRole("checkbox", { name: "Tokens", exact: true }).isChecked(), false)
    await page.getByRole("checkbox", { name: "Tokens", exact: true }).check()
    await page.keyboard.press("Escape")
    await metrics.locator(".usage-metric-chip").first().waitFor()
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Status fixture failure", errors, await page.locator("body").innerText())
    throw error
  } finally { await page.close() }
})

for (const available of [true, false]) test(`session token updates preserve ${available ? "quota" : "unavailable"} Usage without repeated reads`, async () => {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, locale: "en-US" })
  await page.addInitScript(() => localStorage.setItem("opencode-session-right-panel-tab-v2", "status"))
  let usageReads = 0
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname.startsWith("/api/usage/")) {
      usageReads++
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        requestedProviderId: "fixture", providerId: "fixture", providerName: "Fixture", supported: true,
        configured: true, ok: available, fetchedAt: Date.now(), windows: available ? { "5h": { usedPercent: 25, remainingPercent: 75, resetAt: null, windowSeconds: 18000 } } : {},
      }) })
    }
    return route.fulfill({ contentType: "application/json", body: "{}" })
  })
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).statusFixture))
    const usage = page.getByRole("button", { name: "Usage", exact: true })
    if (await usage.getAttribute("aria-expanded") !== "true") await usage.click()
    const content = available ? page.getByRole("progressbar") : page.getByText("Usage is temporarily unavailable.", { exact: true })
    await content.waitFor()
    const element = await content.elementHandle()
    assert.equal(usageReads, 1)
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => (window as any).statusFixture.update())
      await page.waitForTimeout(10)
    }
    assert.equal(usageReads, 1, "streaming session updates must not produce repeated quota requests")
    assert.equal(await element!.evaluate(el => el.isConnected), true, "Usage DOM must survive session object replacement")
    const nextRead = page.waitForResponse(response => new URL(response.url()).pathname.startsWith("/api/usage/")
      && new URL(response.url()).searchParams.get("sessionId") === "another-session")
    await page.evaluate(() => (window as any).statusFixture.select("another-session"))
    await nextRead
    await content.waitFor()
    assert.equal(usageReads, 2, "a real session identity change must still revalidate Usage")
  } finally { await page.close() }
})
