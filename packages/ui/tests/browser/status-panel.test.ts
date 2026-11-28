import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
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

test("Missions keeps layout visibility independent of the exact Global activation write", async () => {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, locale: "en-US" })
  const pluginId = "codenomad.missions", controls = "**/api/workspaces/status-fixture/plugin-controls**"
  const writes: unknown[] = []
  let fail = false
  const releaseFailure = Promise.withResolvers<void>()
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.route(controls, async route => {
    if (route.request().method() !== "PATCH") {
      return route.fulfill({ status: 503, json: {} })
    }
    const body = route.request().postDataJSON()
    writes.push(body)
    const target = { scope: "global", path: "/daemon/opencode.jsonc", exists: true }
    if (fail) {
      await releaseFailure.promise
      return route.fulfill({ status: 503, json: {} })
    }
    return route.fulfill({ json: {
      snapshot: { location: { directory: "/fixture" }, targets: [target], controls: [], runtime: [], configured: { rules: [], sources: [] } },
      rule: body.enabled ? pluginId : `-${pluginId}`, target, changed: true, reloadPending: true,
    } })
  })
  await page.addInitScript(() => {
    if (sessionStorage.getItem("status-missions-layout-seeded")) return
    sessionStorage.setItem("status-missions-layout-seeded", "true")
    localStorage.setItem("opencode-session-right-panel-tab-v2", "missions")
    localStorage.setItem("opencode-session-right-panel-customization-v1", JSON.stringify({ tabOrder: ["files", "status", "missions"] }))
  })
  const customize = page.getByRole("button", { name: "Customize right panel" })
  const tab = page.getByRole("tab", { name: "Missions", exact: true })
  const checkbox = page.getByRole("checkbox", { name: "Missions", exact: true, includeHidden: true })
  const dialog = page.getByRole("dialog")
  const hidden = () => page.evaluate(() => (window as any).statusFixture.customization().hiddenTabIds)
  const payload = (enabled: boolean) => ({ location: { directory: "/fixture" }, pluginId, scope: "global", enabled, managedBy: "codenomad" })
  try {
    await page.goto(url)
    await page.getByRole("tab", { name: "Missions", exact: true, selected: true }).waitFor()
    await customize.click()
    await checkbox.press("Space")
    await dialog.getByText("Disable Missions in OpenCode’s Global configuration? Nothing is deleted or paused.").waitFor({ timeout: 4500 })
    assert.equal(await checkbox.isChecked(), true)
    assert.deepEqual(writes, [])
    await dialog.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
    await tab.waitFor()
    await page.waitForFunction(() => document.activeElement instanceof HTMLInputElement
      && document.activeElement.labels?.[0]?.textContent?.trim() === "Missions")
    assert.deepEqual(writes, [])
    await checkbox.click()
    await dialog.waitFor()
    await page.evaluate(() => (window as any).statusFixture.setPanelMounted(false))
    await dialog.waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).statusFixture.setPanelMounted(true))
    await tab.waitFor()
    assert.deepEqual(writes, [])
    if (!await checkbox.count()) await customize.click()
    await checkbox.click()
    const write = () => page.waitForResponse(response => response.url().endsWith("/plugin-controls") && response.request().method() === "PATCH")
    await Promise.all([write(), dialog.getByRole("button", { name: "Confirm", exact: true }).click()])
    await tab.waitFor({ state: "detached" })
    await page.getByRole("tab", { name: "Files", exact: true, selected: true }).waitFor()
    assert.deepEqual(await hidden(), ["missions"])
    assert.deepEqual(writes, [payload(false)])
    await page.reload()
    await customize.click()
    assert.equal(await checkbox.isChecked(), false)
    assert.equal(await tab.count(), 0)
    assert.deepEqual(writes, [payload(false)], "mount and restore only read layout")
    fail = true
    await Promise.all([page.waitForRequest(request => request.url().endsWith("/plugin-controls") && request.method() === "PATCH"), checkbox.click()])
    await page.evaluate(() => (window as any).statusFixture.setPanelActive(false))
    releaseFailure.resolve()
    await page.getByText("Could not save Missions in Global.", { exact: true }).waitFor({ timeout: 4500 })
    await page.evaluate(() => (window as any).statusFixture.setPanelActive(true))
    await tab.waitFor()
    assert.deepEqual(await hidden(), [])
    await page.getByRole("tab", { name: "Files", exact: true, selected: true }).waitFor()
    assert.deepEqual(writes, [payload(false), payload(true)])
  } finally { releaseFailure.resolve(); await page.close() }
})

test("sweeping across Missions toggles surrounding layout checkboxes without confirmation", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 }, locale: "en-US" })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.addInitScript(() => {
    localStorage.setItem("opencode-session-right-panel-customization-v1", JSON.stringify({ tabOrder: ["status", "missions", "files"] }))
  })
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Customize right panel" }).click()
    const box = (name: string) => page.getByRole("checkbox", { name, exact: true, includeHidden: true })
    const files = await box("Files").boundingBox(), missions = await box("Missions").boundingBox()
    const popup = page.getByRole("group", { name: "Customize right panel" })
    const lastSection = popup.locator("[data-status-section-toggle]").last()
    const section = await lastSection.boundingBox()
    assert.ok(files && missions && section && section.y < missions.y && missions.y < files.y)
    await page.mouse.move(section.x + section.width / 2, section.y + section.height / 2)
    await page.mouse.down()
    await page.mouse.move(files.x + files.width / 2, files.y + files.height / 2, { steps: 12 })
    await page.mouse.up()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await box("Missions").isChecked(), true)
    assert.equal(await box("Files").isChecked(), false)
    assert.equal(await lastSection.isChecked(), false)
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
      statusSectionOrder: ["plan", "permissions", "provider-usage"], hiddenStatusSectionIds: ["plan"],
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

test("Status sections reorder only from their grip, never from the card body", async () => {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.addInitScript(() => localStorage.setItem("opencode-session-right-panel-tab-v2", "status"))
  const sectionIds = (page: Page) => page.locator("[data-status-section]").evaluateAll(rows => rows.map(row => row.getAttribute("data-status-section")))
  /** A real pointer pull in small steps, so the sortable's activation distance is crossed. */
  const pull = async (from: { x: number; y: number }, dy: number) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let step = 1; step <= 12; step++) await page.mouse.move(from.x, from.y + dy * step / 12)
  }
  const activeDrags = () => page.locator(".right-panel-section-draggable-active").count()
  try {
    await page.goto(url)
    const tokens = page.locator('[data-status-section="tokens"]')
    await tokens.waitFor()
    const initial = await sectionIds(page)
    // The card body (trigger, summary, content) never arms a drag: touching a card to read or scroll it stays inert.
    const trigger = await tokens.locator("[data-status-section-trigger]").boundingBox()
    const usage = await page.locator('[data-status-section="provider-usage"]').boundingBox()
    assert.ok(trigger && usage)
    const dy = usage.y + usage.height * 0.75 - (trigger.y + trigger.height / 2)
    await pull({ x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height / 2 }, dy)
    assert.equal(await activeDrags(), 0, "a pull on the card body arms no drag")
    assert.deepEqual(await sectionIds(page), initial, "a pull on the card body reorders nothing")
    await page.mouse.up()
    assert.deepEqual(await sectionIds(page), initial)
    // The grip alone reorders, with a touch surface that owns its gestures.
    const grip = tokens.locator(".right-panel-section-grip")
    assert.equal(await grip.evaluate(element => getComputedStyle(element).touchAction), "none", "the grip owns touch gestures")
    const start = await grip.boundingBox()
    assert.ok(start)
    await pull({ x: start.x + start.width / 2, y: start.y + start.height / 2 }, dy)
    assert.equal(await activeDrags(), 1, "the grip arms the drag")
    assert.ok(await tokens.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).m42 > 10),
      "the dragged card follows the pointer")
    assert.ok(await grip.evaluate(element => {
      const card = element.closest("[data-status-section]")
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return Boolean(hit && card && card.contains(hit))
    }), "the dragged card paints above its neighbour")
    await page.mouse.up()
    const at = initial.indexOf("provider-usage")
    const expected = [...initial.slice(1, at + 1), initial[0], ...initial.slice(at + 1)]
    assert.deepEqual(await sectionIds(page), expected, "dragging the grip moves the section next to the drop target")
    assert.deepEqual(await page.evaluate(() => (window as any).statusFixture.customization().statusSectionOrder),
      expected, "the reorder persists")
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Status fixture failure", errors, await page.locator("body").innerText())
    throw error
  } finally { await page.close() }
})

test("a dragged Status section paints above the neighbour it slides over", async () => {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.addInitScript(() => localStorage.setItem("opencode-session-right-panel-tab-v2", "status"))
  const sectionIds = (page: Page) => page.locator("[data-status-section]").evaluateAll(rows => rows.map(row => row.getAttribute("data-status-section")))
  try {
    await page.goto(url)
    const tokens = page.locator('[data-status-section="tokens"]')
    await tokens.waitFor()
    const initial = await sectionIds(page)
    // A collapsed Tokens card is one header tall; the expanded Permissions section sits right below it.
    const trigger = tokens.locator("[data-status-section-trigger]")
    if (await trigger.getAttribute("aria-expanded") !== "false") await trigger.click()
    const grip = tokens.locator(".right-panel-section-grip")
    const start = await grip.boundingBox()
    assert.ok(start)
    // A short pull, far less than the neighbour's height: the card slides over it without reordering.
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()
    for (let step = 1; step <= 6; step++) await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + step * 4.5)
    assert.equal(await page.locator(".right-panel-section-draggable-active").count(), 1, "the grip arms the drag")
    assert.ok(await grip.evaluate(element => {
      const card = element.closest("[data-status-section]")
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return Boolean(hit && card && card.contains(hit))
    }), "the dragged card's grip paints above the neighbour")
    assert.ok(await tokens.locator(".section-label").evaluate(element => {
      const card = element.closest("[data-status-section]")
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return Boolean(hit && card && card.contains(hit))
    }), "the dragged card's title paints above the neighbour")
    await page.mouse.up()
    assert.deepEqual(await sectionIds(page), initial, "a short pull reorders nothing")
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Status fixture failure", errors, await page.locator("body").innerText())
    throw error
  } finally { await page.close() }
})
