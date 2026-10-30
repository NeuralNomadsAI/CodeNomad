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
const center = async (locator: ReturnType<Page["locator"]>) => {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
const pressed = (column: ReturnType<Page["locator"]>) => column.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-pressed")))

test("dragging across Message content toggles gives every crossed row of that column the first one's new state", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1200, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    // Slow saves: the sweep crosses rows while earlier rows are still saving.
    await page.goto(`${fixture.url}?saveDelay=400`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.getByRole("button", { name: "Message content", exact: true }).click()
    await preset(page).selectOption("everything")
    await page.waitForFunction(() => (window as any).fixture.preferences().toolCallExpansionDefaults.preset === "everything")
    const eyes = page.locator('.transcript-filter-row [data-toggle-sweep="transcript-visibility"]')
    const chevrons = page.locator('.transcript-filter-row [data-toggle-sweep="transcript-expansion"]')
    const idle = () => page.locator('.transcript-filters[aria-busy="false"]').waitFor()
    assert.ok(await eyes.count() >= 7)
    await eyes.nth(2).click()
    await idle()
    assert.deepEqual((await pressed(eyes)).slice(0, 5), ["true", "true", "false", "true", "true"])

    // One jump from the first eye to the fourth, back to the first, and release there:
    // the first flips once, the rows jumped over follow, and the hidden one stays hidden.
    const first = await center(eyes.nth(0)), fourth = await center(eyes.nth(3))
    const savesBefore = await page.evaluate(() => (window as any).fixture.saves())
    await page.mouse.move(first.x, first.y)
    await page.mouse.down()
    await page.mouse.move(fourth.x, fourth.y)
    await page.mouse.move(first.x, first.y)
    // During the drag only the popup changes: nothing is saved, so the transcript stays put.
    assert.deepEqual((await pressed(eyes)).slice(0, 5), ["false", "false", "false", "false", "true"])
    assert.equal(await page.evaluate(() => (window as any).fixture.saves()) - savesBefore, 0)
    await page.mouse.up()
    // The release saves the whole sweep in one write; rows keep their state meanwhile.
    assert.equal(await page.locator(".transcript-filters").getAttribute("aria-busy"), "true")
    assert.deepEqual((await pressed(eyes)).slice(0, 5), ["false", "false", "false", "false", "true"])
    await idle()
    assert.deepEqual((await pressed(eyes)).slice(0, 5), ["false", "false", "false", "false", "true"])
    assert.equal(await page.evaluate(() => (window as any).fixture.saves()) - savesBefore, 1)
    assert.deepEqual((await page.evaluate(() => (window as any).fixture.savedModes() as string[])).slice(0, 5).map(mode => mode !== "hidden"),
      [false, false, false, false, true])
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "")

    // The chevron column sweeps on its own; crossing into the eyes leaves them alone.
    const before = await pressed(chevrons), savesBeforeChevrons = await page.evaluate(() => (window as any).fixture.saves())
    const from = await center(chevrons.nth(4)), to = await center(chevrons.nth(6)), eye = await center(eyes.nth(6))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await page.mouse.move(eye.x, eye.y, { steps: 4 })
    await page.mouse.up()
    await idle()
    const flipped = before[4] === "true" ? "false" : "true"
    assert.deepEqual((await pressed(chevrons)).slice(4, 7), [flipped, flipped, flipped])
    assert.deepEqual((await pressed(eyes)).slice(4, 7), ["true", "true", "true"])
    // A slow drag over many moves still saves once.
    assert.equal(await page.evaluate(() => (window as any).fixture.saves()) - savesBeforeChevrons, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("queued Message content changes keep their order around presets and sweeps still held", async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1200, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(`${fixture.url}?saveDelay=400`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.getByRole("button", { name: "Message content", exact: true }).click()
    await preset(page).selectOption("everything")
    await page.waitForFunction(() => (window as any).fixture.preferences().toolCallExpansionDefaults.preset === "everything")
    const eyes = page.locator('.transcript-filter-row [data-toggle-sweep="transcript-visibility"]')
    const idle = () => page.locator('.transcript-filters[aria-busy="false"]').waitFor()
    const shown = async () => (await page.evaluate(() => (window as any).fixture.savedModes() as string[])).map(mode => mode !== "hidden")

    // A save in flight and a click queued behind it, then a sweep held down: the queued save
    // carries its own click only; the sweep saves on release.
    await eyes.nth(0).click()
    await eyes.nth(1).click()
    const from = await center(eyes.nth(3)), to = await center(eyes.nth(5))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 4 })
    await idle()
    assert.deepEqual((await shown()).slice(0, 6), [false, false, true, true, true, true])
    await page.mouse.up()
    await idle()
    assert.deepEqual((await shown()).slice(0, 6), [false, false, true, false, false, false])

    // A click queued, a preset, then a row: the row applies after the preset.
    await eyes.nth(0).click()
    await eyes.nth(1).click()
    await preset(page).selectOption("balanced")
    const inputs = page.getByRole("group", { name: "Input", exact: true }).locator('[data-toggle-sweep="transcript-visibility"]')
    const inputsShown = await inputs.getAttribute("aria-pressed")
    await inputs.click()
    await idle()
    const index = await page.locator(".transcript-filter-row").evaluateAll(rows => rows.findIndex(row => row.getAttribute("aria-label") === "Input"))
    assert.equal((await shown())[index], inputsShown !== "true")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

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
