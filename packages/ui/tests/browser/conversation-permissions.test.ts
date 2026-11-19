import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import type { ConversationPermissionMode, WorkspaceEventPayload } from "../../../server/src/api-types"

let browser: Browser, url: string, events: Awaited<ReturnType<typeof fixtureEventStream>>
const captures = process.env.CODENOMAD_PERMISSIONS_CAPTURE_DIR

before(async () => {
  const fixture = await borrowFixture({ name: "conversation-permissions", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/status-panel.tsx"></script></body></html>' }] })
  url = fixture.url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  if (captures) await mkdir(captures, { recursive: true })
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

const modeSelect = (page: Page) => page.getByRole("combobox", { name: "Permissions", exact: true })
const statusTab = (page: Page) => page.getByRole("tab", { name: "Status", exact: true })
const permissionSection = (page: Page) => page.locator('[data-status-section="permissions"]')
const sectionIds = (page: Page) => page.locator("[data-status-section]").evaluateAll(rows => rows.map(row => row.getAttribute("data-status-section")))
const expectValue = (select: Locator, mode: ConversationPermissionMode) => select.locator(`option[value="${mode}"]:checked`).waitFor({ state: "attached" })
const expectFocus = async (target: Locator) => target.page().waitForFunction(el => el === document.activeElement, await target.elementHandle())
const permissionUpdate = (sessionID: string, instanceId = "status-fixture") => events.send({
  type: "instance.event", instanceId, event: { type: "session.permissions", data: { sessionID, permissions: [] } },
} as WorkspaceEventPayload)

function statusFixtureResponse(route: Route) {
  const path = new URL(route.request().url()).pathname
  const json = path === "/api/panel-extensions" ? []
    : path.endsWith("/background-shells") ? { data: [], location: { directory: "/fixture" } }
    : path === "/api/storage/config/ui" ? { settings: { locale: "en" } }
    : {}
  return route.fulfill({ json })
}

async function openPage(options: Parameters<Browser["newPage"]>[0] = {}) {
  const page = await browser.newPage({ locale: "en-US", ...options })
  page.setDefaultTimeout(10_000)
  page.on("pageerror", error => console.error(error))
  return page
}

test("Status shows confirmed modes, follows another window and reconciles on reconnect", async () => {
  const pages = await Promise.all([openPage(), openPage()])
  let mode: ConversationPermissionMode = "autonomous"
  let attempts = 0
  let reject = false
  let failOtherReads = false
  let release!: () => void
  let allowReconnectRead!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const reconnectRead = new Promise<void>(resolve => { allowReconnectRead = resolve })
  try {
    await Promise.all(pages.map(async (page, index) => {
      await page.route("**/api/**", statusFixtureResponse)
      await page.route("**/permission-mode", async route => {
        const id = new URL(route.request().url()).pathname.split("/").at(-2)
        if (route.request().method() === "PUT") {
          assert.equal(id, "ses_status")
          attempts++
          if (reject) return route.fulfill({ status: 409 })
          const body = route.request().postDataJSON()
          assert.deepEqual(body, { mode: "supervised" })
          await held
          mode = body.mode
          permissionUpdate(id)
        } else if (index === 1 && failOtherReads && id === "ses_status") {
          return route.fulfill({ status: 503 })
        }
        return route.fulfill({ json: { mode: id === "ses_status" ? mode : "autonomous" } })
      })
      await events.route(page)
      await page.goto(url)
      await statusTab(page).click()
      await page.waitForFunction(() => (window as any).statusFixture?.streamOpens() > 0)
      await expectValue(modeSelect(page), "autonomous")
    }))
    const [first, other] = pages
    const select = modeSelect(first)
    assert.deepEqual((await sectionIds(first)).slice(0, 3), ["tokens", "permissions", "provider-usage"])
    assert.equal(await select.evaluate(element => element.tagName), "SELECT")
    const status = permissionSection(first).getByRole("status")
    await status.filter({ hasText: "Permissions: Autonomous" }).waitFor({ state: "attached" })
    await select.selectOption("supervised")
    assert.equal(await select.inputValue(), "autonomous")
    await status.filter({ hasText: "Updating permissions…" }).waitFor({ state: "attached" })
    release()
    await expectValue(select, "supervised")
    await expectValue(modeSelect(other), "supervised")
    await status.filter({ hasText: "Permissions: Supervised" }).waitFor({ state: "attached" })
    if (captures) await permissionSection(first).screenshot({ path: join(captures, "status-supervised.png") })

    const otherSection = permissionSection(other)
    const stale = otherSection.getByRole("status").filter({ hasText: "Mode not confirmed." })
    const reload = otherSection.getByRole("button", { name: "Reload permissions" })
    failOtherReads = true
    mode = "autonomous"
    permissionUpdate("ses_status")
    await expectValue(select, "autonomous")
    await stale.waitFor()
    assert.equal(await modeSelect(other).inputValue(), "supervised", "a failed refresh retains the last known mode")
    assert.equal(await modeSelect(other).getAttribute("aria-disabled"), "true")
    failOtherReads = false
    await reload.click()
    await expectValue(modeSelect(other), "autonomous")
    await stale.waitFor({ state: "hidden" })

    await select.selectOption("supervised")
    await expectValue(select, "supervised")
    await expectValue(modeSelect(other), "supervised")
    reject = true
    await select.selectOption("autonomous")
    await first.getByText("Couldn’t change permissions. Try again.", { exact: true }).waitFor()
    assert.equal(await select.inputValue(), "supervised")
    assert.equal(attempts, 3, "reconciliation never replays the write")

    await first.evaluate(() => (window as any).statusFixture.select("ses_other"))
    await expectValue(select, "autonomous")
    await first.evaluate(() => (window as any).statusFixture.select("ses_status"))
    await expectValue(select, "supervised")
    mode = "autonomous"
    await other.route("**/permission-mode", async route => {
      if (route.request().method() !== "GET") return route.fallback()
      await reconnectRead
      return route.fulfill({ json: { mode } })
    })
    await other.evaluate(() => (window as any).statusFixture.reconnect())
    await stale.waitFor()
    assert.equal(await modeSelect(other).inputValue(), "supervised", "a disconnect removes confirmation before the reconnect read settles")
    allowReconnectRead()
    await expectValue(modeSelect(other), "autonomous")
    await stale.waitFor({ state: "hidden" })
    assert.equal(await select.inputValue(), "supervised", "no event was delivered to the original window")
  } catch (error) {
    console.error(await pages[0].locator("body").innerText())
    throw error
  } finally { release(); allowReconnectRead(); await Promise.all(pages.map(page => page.close())) }
})

test("Permissions help is named and Escape closes it before and after autofocus", async () => {
  const page = await openPage()
  try {
    await page.route("**/api/**", statusFixtureResponse)
    await page.route("**/permission-mode", route => route.fulfill({ json: { mode: "autonomous" } }))
    await events.route(page)
    await page.goto(url)
    await statusTab(page).click()
    const name = "About permission modes"
    const info = permissionSection(page).getByRole("button", { name })
    const dialog = page.getByRole("dialog", { name, exact: true })
    await info.press("Enter")
    await expectFocus(dialog)
    await dialog.getByText("New subagents inherit these rules.", { exact: true }).waitFor()
    if (captures) await dialog.screenshot({ path: join(captures, "status-permissions-info.png") })
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    await expectFocus(info)

    // Dispatch in one turn to exercise Escape while the trigger still owns focus.
    assert.deepEqual(await info.evaluate(button => {
      ;(button as HTMLButtonElement).click()
      const openedWithTriggerFocused = button.getAttribute("aria-expanded") === "true" && document.activeElement === button
      const escaped = !button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      return { openedWithTriggerFocused, escaped, closed: button.getAttribute("aria-expanded") === "false" }
    }), { openedWithTriggerFocused: true, escaped: true, closed: true })
    await dialog.waitFor({ state: "hidden" })
    await expectFocus(info)
    await expectValue(modeSelect(page), "autonomous")
    await info.click()
    await dialog.waitFor()
    await statusTab(page).click()
    await dialog.waitFor({ state: "hidden" })
  } finally { await page.close() }
})

test("Status restores the saved position and visibility of Permissions", async () => {
  const page = await openPage()
  try {
    await page.route("**/api/**", statusFixtureResponse)
    await page.route("**/permission-mode", route => route.fulfill({ json: { mode: "autonomous" } }))
    await events.route(page)
    await page.addInitScript(() => {
      const key = "opencode-session-right-panel-customization-v1"
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
        statusSectionOrder: ["provider-usage", "yolo-mode", "tokens"], hiddenStatusSectionIds: ["yolo-mode"],
      }))
    })
    await page.goto(url)
    await statusTab(page).click()
    await page.getByRole("button", { name: "Customize right panel" }).click()
    const choice = page.getByRole("checkbox", { name: "Permissions", exact: true })
    assert.equal(await choice.isChecked(), false)
    await choice.check()
    await page.keyboard.press("Escape")
    await expectValue(modeSelect(page), "autonomous")
    assert.deepEqual((await sectionIds(page)).slice(0, 3), ["provider-usage", "permissions", "tokens"])
    await page.reload()
    await statusTab(page).click()
    await expectValue(modeSelect(page), "autonomous")
    assert.deepEqual((await sectionIds(page)).slice(0, 3), ["provider-usage", "permissions", "tokens"])
  } catch (error) {
    console.error(await page.locator("body").innerText())
    throw error
  } finally { await page.close() }
})

test("General saves the new-conversation mode immediately before Queue sent prompts", async () => {
  const page = await openPage({ viewport: { width: 830, height: 900 } })
  let value: ConversationPermissionMode | undefined
  let reject = true
  let attempts = 0
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/storage/config/ui", async route => {
      if (route.request().method() === "PATCH") {
        attempts++
        const patch = route.request().postDataJSON()
        assert.deepEqual(patch, { settings: { newConversationPermissions: "supervised" } })
        if (reject) return route.fulfill({ status: 503 })
        await held
        value = patch.settings.newConversationPermissions
      }
      return route.fulfill({ json: { settings: { locale: "en", newConversationPermissions: value } } })
    })
    await events.route(page)
    await page.goto(`${url}?settings`)
    const setting = page.getByRole("button", { name: /^New conversation permissions\b/ })
    assert.equal(await setting.innerText(), "Autonomous")
    assert.match(await setting.evaluate(el => el.closest(".settings-toggle-row")?.nextElementSibling?.textContent ?? ""), /Queue sent prompts/)
    async function supervise() {
      await setting.click()
      await page.getByRole("option", { name: "Supervised", exact: true }).click()
    }
    await supervise()
    await page.getByText("Couldn’t save the default. Try again.", { exact: true }).waitFor()
    assert.equal(await setting.innerText(), "Autonomous")
    assert.equal(value, undefined)
    reject = false
    await supervise()
    await page.locator('button[aria-label="New conversation permissions"][aria-disabled="true"]').waitFor()
    await expectFocus(setting)
    await page.keyboard.press("Enter")
    assert.equal(await setting.getAttribute("aria-expanded"), "false")
    await page.keyboard.press("Tab")
    const queueRow = page.getByRole("checkbox", { name: "Queue sent prompts", exact: true }).locator("..")
    assert.ok(await queueRow.evaluate(row => row.contains(document.activeElement)))
    release()
    await setting.getByText("Supervised", { exact: true }).waitFor()
    assert.equal(value, "supervised")
    assert.equal(attempts, 2)
    await page.reload()
    await setting.getByText("Supervised", { exact: true }).waitFor()
    if (captures) await page.locator(".settings-card").filter({ has: setting }).screenshot({ path: join(captures, "preferences-new-conversations.png") })
  } catch (error) {
    console.error(await page.locator("body").innerText())
    throw error
  } finally { release(); await page.close() }
})
