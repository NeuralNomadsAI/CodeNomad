import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { Page } from "playwright"
import { startProductFixture } from "./fixtures/product-fixture-server"

// The status-tokens fixture renders the real Message content popup beside Settings → Chat.
let fixture: Awaited<ReturnType<typeof startProductFixture>>
const captures = fileURLToPath(new URL("../../../../.tmp/transcript-presets/", import.meta.url))
before(async () => { fixture = await startProductFixture("status-tokens"); await mkdir(captures, { recursive: true }) })
after(async () => { await fixture?.close() })

const preset = (page: Page) => page.locator(".transcript-filters-preset select")
const settingsPreset = (page: Page) => page.locator('.settings-expansion-preset[aria-pressed="true"] .settings-expansion-preset-title')
const options = (page: Page) => preset(page).locator("option").evaluateAll(items =>
  items.map(item => ({ value: (item as HTMLOptionElement).value, label: item.textContent, hidden: (item as HTMLOptionElement).hidden })))
const saved = (page: Page) => page.evaluate(() => (window as any).fixture.preferences().toolCallExpansionDefaults.preset)

test("Message content chooses presets, names manual changes Custom and follows the language", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1200, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(fixture.url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.deepEqual(await page.locator(".settings-expansion-preset-title").allTextContents(), ["Nothing", "Minimal", "Balanced", "Everything"])

    await page.getByRole("button", { name: "Message content", exact: true }).click()
    assert.equal(await preset(page).getAttribute("aria-label"), "Transcript detail presets")
    assert.equal(await preset(page).inputValue(), "balanced")
    assert.deepEqual(await options(page), [
      { value: "nothing", label: "Nothing", hidden: false }, { value: "minimal", label: "Minimal", hidden: false },
      { value: "balanced", label: "Balanced", hidden: false }, { value: "everything", label: "Everything", hidden: false },
      { value: "custom", label: "Custom", hidden: true },
    ])
    // The preset sits under the title, above the rows.
    const order = await page.locator(".transcript-filters").evaluate(popup => [...popup.children].map(child => child.className))
    const at = (name: string) => order.findIndex(className => className.split(" ").includes(name))
    assert.ok(at("window-header") < at("transcript-filters-preset") && at("transcript-filters-preset") < at("transcript-filters-list"), order.join(" | "))

    await preset(page).selectOption("nothing")
    await page.waitForFunction(() => (window as any).fixture.preferences().toolCallExpansionDefaults.preset === "nothing")
    assert.equal(await settingsPreset(page).textContent(), "Nothing")
    const rows = page.locator(".transcript-filter-row")
    for (const label of await rows.evaluateAll(items => items.map(item => item.getAttribute("aria-label")!))) {
      assert.equal(await page.getByRole("group", { name: label, exact: true }).getByRole("button", { name: `Show ${label}`, exact: true }).count(), 1, label)
    }
    await page.locator(".transcript-filters").screenshot({ path: `${captures}/nothing.png` })

    await page.getByRole("group", { name: "read", exact: true }).getByRole("button", { name: "Show read", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.preferences().toolCallExpansionDefaults.preset === "custom")
    assert.equal(await preset(page).inputValue(), "custom")
    assert.equal((await options(page)).find(option => option.value === "custom")?.hidden, false)
    assert.equal(await settingsPreset(page).count(), 0, "no Settings preset claims a manual change")
    await page.locator(".transcript-filters").screenshot({ path: `${captures}/custom.png` })

    // Pointer choice in the open list keeps the popup; Escape closes the list before the popup.
    const listOpen = () => preset(page).evaluate(select => select.matches(":open"))
    await preset(page).click()
    assert.equal(await listOpen(), true)
    await preset(page).locator('option[value="everything"]').click()
    await page.waitForFunction(() => (window as any).fixture.preferences().toolCallExpansionDefaults.preset === "everything")
    assert.equal(await preset(page).inputValue(), "everything")
    assert.equal(await settingsPreset(page).textContent(), "Everything")
    assert.equal(await page.locator(".transcript-filters").count(), 1)
    await preset(page).click()
    assert.equal(await listOpen(), true)
    await page.keyboard.press("Escape")
    assert.equal(await listOpen(), false)
    assert.equal(await page.locator(".transcript-filters").count(), 1, "Escape closed only the list")
    await page.keyboard.press("Escape")
    await page.locator(".transcript-filters").waitFor({ state: "detached" })
    await page.getByRole("button", { name: "Message content", exact: true }).click()

    await page.evaluate(() => (window as any).fixture.updatePreferences({ locale: "fr" }))
    await page.waitForFunction(() => document.querySelector(".transcript-filters-preset option")?.textContent === "Rien")
    assert.deepEqual((await options(page)).map(option => option.label), ["Rien", "Minimal", "Équilibré", "Tout", "Personnalisé"])
    assert.deepEqual(await page.locator(".settings-expansion-preset-title").allTextContents(), ["Rien", "Minimal", "Équilibré", "Tout"])
    assert.equal(await preset(page).getAttribute("aria-label"), "Préréglages de détail de conversation")
    assert.equal(await saved(page), "everything")
    await page.locator(".transcript-filters").screenshot({ path: `${captures}/fr.png` })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
