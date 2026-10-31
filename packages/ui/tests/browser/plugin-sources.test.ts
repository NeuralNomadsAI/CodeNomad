import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string

before(async () => {
  const fixture = await borrowFixture({
    name: "plugin-sources",
    routes: [
      { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/plugin-sources.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})

after(async () => { await browser?.close() })

const calls = (page: Page, type: string) => page.evaluate(kind => (window as any).fixture.calls.filter((call: any) => call.type === kind), type)

async function openAdd(page: Page) {
  await page.getByRole("button", { name: "Add plugin", exact: true }).click()
  return page.getByRole("dialog", { name: "Add a plugin" })
}

async function tooltip(page: Page, row: string) {
  await page.mouse.move(0, 0)
  await page.locator(`${row} .plugin-control-name`).focus()
  const content = page.locator(".plugin-control-tooltip")
  await content.waitFor()
  const text = await content.innerText()
  await page.locator(`${row} .plugin-control-name`).blur()
  return text
}

test("adding a plugin defaults to Global, warns for Project and shows Installing until the inventory reports it", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 800 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    const dialog = await openAdd(page)
    const scope = dialog.getByLabel("Scope", { exact: true })
    assert.equal(await scope.inputValue(), "global", "Global is the default scope")
    await dialog.getByText("The plugin's code runs with your permissions inside OpenCode.", { exact: true }).waitFor()
    assert.equal(await dialog.getByRole("note").count(), 0)
    await scope.selectOption("project")
    assert.match(await dialog.getByRole("note").innerText(), /runs whenever this folder is opened/)
    await scope.selectOption("global")
    const input = dialog.getByLabel("Package", { exact: true })
    const styles = await dialog.evaluate((element, field) => {
      // Resolve the field role to a concrete colour the same way the input's background is computed.
      const probe = document.createElement("div")
      probe.style.backgroundColor = "var(--surface-field)"
      element.appendChild(probe)
      const fieldRole = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { radius: getComputedStyle(element).borderTopLeftRadius, field: getComputedStyle(field as Element).backgroundColor, fieldRole }
    }, await input.elementHandle())
    assert.equal(styles.radius, "0px", "square window corners")
    assert.equal(styles.field, styles.fieldRole, "the spec input uses the field surface role")
    await input.fill("fixture-plugin@1.0.0")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.deepEqual(await calls(page, "add"), [{ type: "add", location: { directory: "/repo" }, scope: "global", spec: "fixture-plugin@1.0.0" }])

    const pending = page.locator('[data-source-target="fixture-plugin@1.0.0"]')
    await pending.waitFor()
    assert.equal(await pending.getAttribute("aria-busy"), "true")
    assert.equal(await pending.getAttribute("data-source-state"), "pending")
    assert.equal(await pending.getByRole("status").innerText(), "Installing")
    assert.equal(await page.getByText("fixture.package", { exact: true }).count(), 0, "no active claim before plugin.list")
    assert.match(await tooltip(page, '[data-source-target="fixture-plugin@1.0.0"]'), /Installing\. OpenCode shows it here once it is loaded\./)

    await page.evaluate(() => (window as any).fixture.report("fixture-plugin@1.0.0", "active", { id: "fixture.package" }))
    const row = page.locator('[data-plugin-id="fixture.package"]')
    await row.waitFor()
    assert.equal(await pending.count(), 0, "the pending row becomes the loaded plugin row")
    const details = await tooltip(page, '[data-plugin-id="fixture.package"]')
    assert.match(details, /Version 1\.0\.0/)
    assert.match(details, /Update available/)

    await row.getByRole("button", { name: "Actions for fixture.package", exact: true }).click()
    const items = await page.getByRole("menuitem").allInnerTexts()
    assert.deepEqual(items.map(item => item.trim()), ["Update fixture-plugin@1.0.0", "Remove from Global"])
    await page.getByRole("menuitem", { name: "Remove from Global", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.calls.some((call: any) => call.type === "remove"))
    assert.deepEqual(await calls(page, "remove"), [{ type: "remove", location: { directory: "/repo" }, scope: "global", target: "fixture-plugin@1.0.0", entryIndex: 1 }])
    await page.evaluate(() => (window as any).fixture.notify())
    await row.waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("an install failure shows its native reference, and a refused spec stays in the window with its reason", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 800 }, locale: "en-US" })
  try {
    await page.goto(url)
    let dialog = await openAdd(page)
    await page.evaluate(() => (window as any).fixture.failNextAdd(409, "duplicate"))
    await dialog.getByLabel("Package", { exact: true }).fill("fixture-plugin@2")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()
    assert.equal(await dialog.getByRole("alert").innerText(), "This package is already declared in an OpenCode configuration that applies here.")
    assert.equal(await dialog.isVisible(), true)
    await page.evaluate(() => (window as any).fixture.failNextAdd(422, "local-path"))
    await dialog.getByLabel("Package", { exact: true }).fill("./local")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()
    await dialog.getByText("Local paths cannot be added here. Declare them in the OpenCode configuration file.", { exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })

    dialog = await openAdd(page)
    await dialog.getByLabel("Package", { exact: true }).fill("missing-plugin@1.0.0")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await page.locator('[data-source-target="missing-plugin@1.0.0"]').waitFor()
    await page.evaluate(() => (window as any).fixture.report("missing-plugin@1.0.0", "failed"))
    const failed = page.locator('[data-package-target="missing-plugin@1.0.0"]')
    await failed.waitFor()
    const details = await tooltip(page, '[data-package-target="missing-plugin@1.0.0"]')
    assert.match(details, /Failed — Plugin failed to load/)
    assert.match(details, /Error reference in the OpenCode log: err_fixture01/)
  } finally { await page.close() }
})

test("a Project choice whose target disappears is refused, never widened to Global", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 800 }, locale: "en-US" })
  try {
    await page.goto(url)
    const dialog = await openAdd(page)
    await dialog.getByLabel("Scope", { exact: true }).selectOption("project")
    await dialog.getByLabel("Package", { exact: true }).fill("project-only")
    await page.evaluate(() => (window as any).fixture.dropProjectTarget())
    await page.waitForFunction(() => document.querySelector<HTMLOptionElement>('.plugin-source-add option[value="project"]')?.disabled === true)
    await dialog.getByRole("button", { name: "Add", exact: true }).click()
    await dialog.getByText("The Project configuration is unavailable for this location.", { exact: true }).waitFor()
    assert.deepEqual((await calls(page, "add")).map((call: any) => call.scope), ["project"])
    assert.equal(await page.locator('[data-source-target="project-only"]').count(), 0)
  } finally { await page.close() }
})

test("a source the inventory never reports leaves Installing after the named window and offers Refresh", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 800 }, locale: "en-US" })
  try {
    await page.clock.install()
    await page.goto(url)
    const dialog = await openAdd(page)
    await dialog.getByLabel("Package", { exact: true }).fill("silent-plugin")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    const row = page.locator('[data-source-target="silent-plugin"]')
    await row.waitFor()
    assert.equal(await row.getAttribute("data-source-state"), "pending")
    await page.clock.fastForward(119_000)
    assert.equal(await row.getAttribute("data-source-state"), "pending")
    await page.clock.fastForward(2_000)
    await page.waitForFunction(() => document.querySelector('[data-source-target="silent-plugin"]')?.getAttribute("data-source-state") === "unconfirmed")
    assert.equal(await row.getAttribute("aria-busy"), "false")
    assert.equal(await row.getByRole("status").innerText(), "Not confirmed")
    const reads = (await calls(page, "read")).length
    await row.getByRole("button", { name: "Actions for silent-plugin", exact: true }).click()
    assert.deepEqual((await page.getByRole("menuitem").allInnerTexts()).map(item => item.trim()), ["Remove from Global", "Refresh plugin controls"])
    await page.getByRole("menuitem", { name: "Refresh plugin controls", exact: true }).click()
    await page.waitForFunction(count => (window as any).fixture.calls.filter((call: any) => call.type === "read").length > count, reads)
  } finally { await page.close() }
})

test("a desktop-app package declared outside Global says its GUI parts load only from Global", async () => {
  const page = await browser.newPage({ viewport: { width: 520, height: 800 }, locale: "en-US" })
  try {
    await page.goto(url)
    const dialog = await openAdd(page)
    await dialog.getByLabel("Scope", { exact: true }).selectOption("project")
    await dialog.getByLabel("Package", { exact: true }).fill("gui-plugin")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.equal((await calls(page, "add")).at(-1).scope, "project")
    await page.locator('[data-source-target="gui-plugin"]').waitFor()
    await page.evaluate(() => (window as any).fixture.notify())
    await page.evaluate(() => (window as any).fixture.report("gui-plugin", "active", { id: "gui.plugin", gui: true }))
    await page.locator('[data-plugin-id="gui.plugin"]').waitFor()
    assert.match(await tooltip(page, '[data-plugin-id="gui.plugin"]'), /desktop app parts, which load only from Global configuration/)
  } finally { await page.close() }
})
