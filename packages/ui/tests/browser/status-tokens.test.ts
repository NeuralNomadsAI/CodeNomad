import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { Page } from "playwright"
import { startProductFixture } from "./fixtures/product-fixture-server"

let fixture: Awaited<ReturnType<typeof startProductFixture>>
const captures = fileURLToPath(new URL("../../../../.tmp/status-tokens/", import.meta.url))
before(async () => { fixture = await startProductFixture("status-tokens"); await mkdir(captures, { recursive: true }) })
after(async () => { await fixture?.close() })
async function open(run: (page: Page) => Promise<void>, query = "") {
  const page = await fixture.browser.newPage({ viewport: { width: 1200, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(fixture.url + query)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}
const trigger = (page: Page) => page.locator("[data-status] .right-panel-accordion-trigger")
const groupValues = (page: Page) => page.locator("[data-status] .status-token-group").evaluateAll(groups => groups.map(group =>
  [...group.children].map(chip => chip.getAttribute("title"))))
const expected = [
  ["Input: 1234567", "Output: 23456", "Cost: $12.34"],
  ["Total In: 1240567", "Total Out: 24356", "Total Cost: $15.94", "Total Reasoning: 650"],
]

test("fresh balanced defaults hide message tokens; every preset and individual filter stays independent of Status", async () => open(async page => {
  assert.equal(await page.evaluate(() => (window as any).fixture.preferences().showUsageMetrics), false)
  assert.equal(await page.locator('.settings-expansion-preset[aria-pressed="true"] .settings-expansion-preset-title').textContent(), "Balanced")
  await trigger(page).click()
  assert.deepEqual(await groupValues(page), expected)
  for (const [index, visible] of [false, false, false, true].entries()) {
    await page.locator(".settings-expansion-preset").nth(index).click()
    await page.waitForFunction(value => (window as any).fixture.preferences().showUsageMetrics === value, visible)
    assert.deepEqual(await groupValues(page), expected)
    await page.getByRole("button", { name: "Message content", exact: true }).click()
    const row = page.getByRole("group", { name: "Tokens", exact: true })
    await row.getByRole("button", { name: visible ? "Hide Tokens" : "Show Tokens", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).fixture.preferences().showUsageMetrics), !visible)
    assert.deepEqual(await groupValues(page), expected)
    await page.keyboard.press("Escape")
    await page.evaluate(() => (window as any).fixture.toggleUsageMetrics())
    assert.equal(await page.evaluate(() => (window as any).fixture.preferences().showUsageMetrics), visible)
    assert.deepEqual(await groupValues(page), expected)
  }
  for (const mode of ["collapsed", "expanded"]) {
    await page.evaluate(usageMetricsExpansion => (window as any).fixture.updatePreferences({ showUsageMetrics: false, usageMetricsExpansion }), mode)
    assert.deepEqual(await groupValues(page), expected)
  }
}))

for (const saved of ["true", "false"]) test(`saved ${saved} token visibility and expansion survive loading`, async () => open(async page => {
  assert.equal(await page.evaluate(() => (window as any).fixture.preferences().showUsageMetrics), saved === "true")
  assert.equal(await page.evaluate(() => (window as any).fixture.preferences().usageMetricsExpansion), "expanded")
}, `?saved=${saved}`))

test("collapsed summary, expanded groups, keyboard disclosure and live session totals at desktop/narrow/RTL widths", async () => open(async page => {
  const header = page.locator("[data-status] .right-panel-accordion-header-row")
  for (const [name, width, direction] of [["desktop", 460, "ltr"], ["narrow", 220, "ltr"], ["narrow-rtl", 220, "rtl"]] as const) {
    await page.evaluate(({ width, direction }) => { (window as any).fixture.width(width); document.querySelector("[data-status]")!.setAttribute("dir", direction) }, { width, direction })
    assert.equal(await header.locator(".status-token-summary").count(), 1)
    assert.equal(await page.locator("[data-status] .status-token-group").count(), 0)
    assert.match(await trigger(page).textContent() ?? "", /Input.*1\.2M.*Output.*23K.*Cost.*\$12.34/)
    assert.match(await page.locator(".status-token-summary").getAttribute("title") ?? "", /Input: 1234567/)
    assert.equal(await page.getByRole("button", { name: /Tokens.*Input: 1234567/ }).count(), 1, "full counts remain in the disclosure's accessible name")
    const geometry = await header.evaluate(element => {
      const summary = element.querySelector<HTMLElement>(".right-panel-section-summary")!
      const chevron = element.querySelector(".disclosure-chevron")!.getBoundingClientRect()
      const button = element.querySelector("button")!.getBoundingClientRect()
      return { overflow: element.scrollWidth > element.clientWidth, truncated: summary.scrollWidth > summary.clientWidth,
        ellipsis: getComputedStyle(summary).textOverflow, chevronInside: chevron.left >= button.left && chevron.right <= button.right }
    })
    assert.equal(geometry.overflow, false)
    assert.equal(geometry.ellipsis, "ellipsis")
    assert.equal(geometry.chevronInside, true)
    if (width === 220) assert.equal(geometry.truncated, true)
    assert.equal(await trigger(page).locator("button").count(), 0, "no nested button in disclosure")
    await page.locator("[data-status]").screenshot({ path: `${captures}/${name}-collapsed.png` })
    await trigger(page).focus()
    await page.keyboard.press("Enter")
    assert.equal(await trigger(page).getAttribute("aria-expanded"), "true")
    assert.equal(await header.locator(".status-token-summary").count(), 0)
    assert.deepEqual(await groupValues(page), expected)
    const groups = await page.locator(".status-token-group").evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, overflow: element.scrollWidth > element.clientWidth }
    }))
    assert.ok(groups[1].top >= groups[0].bottom, "session and thread rows never mix")
    assert.ok(groups.every(group => !group.overflow))
    await page.locator("[data-status]").screenshot({ path: `${captures}/${name}-expanded.png` })
    await page.keyboard.press("Space")
    assert.equal(await trigger(page).getAttribute("aria-expanded"), "false")
    assert.equal(await trigger(page).evaluate(element => element === document.activeElement), true)
  }
  await page.evaluate(() => (window as any).fixture.usage("parent", 456789, 1234, 4.56, 80))
  assert.match(await trigger(page).textContent() ?? "", /457K/)
  await trigger(page).click()
  assert.deepEqual((await groupValues(page))[1], ["Total In: 462789", "Total Out: 2134", "Total Cost: $8.16", "Total Reasoning: 230"])
  await page.evaluate(() => (window as any).fixture.select("subscription"))
  assert.deepEqual(await groupValues(page), [["Input: 9876", "Output: 543", "Cost: Included"]])
  await trigger(page).click()
  assert.match(await trigger(page).textContent() ?? "", /Included/)
  await page.evaluate(() => (window as any).fixture.select("parent"))
  assert.match(await trigger(page).textContent() ?? "", /457K/)
}))
