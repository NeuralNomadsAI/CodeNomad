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

const statusTab = (page: Page) => page.getByRole("tab", { name: "Status", exact: true })
const permissionSection = (page: Page) => page.locator('[data-status-section="permissions"]')
const permissionTrigger = (page: Page) => permissionSection(page).locator("[data-status-section-trigger]")
const modeGroup = (page: Page) => permissionSection(page).getByRole("group", { name: "Permissions", exact: true })
const modeNames = { autonomous: "Autonomous", supervised: "Supervised" }
const modeButton = (page: Page, mode: ConversationPermissionMode) => modeGroup(page).getByRole("button", { name: modeNames[mode], exact: true })
const sectionIds = (page: Page) => page.locator("[data-status-section]").evaluateAll(rows => rows.map(row => row.getAttribute("data-status-section")))
const expectMode = async (page: Page, mode: ConversationPermissionMode) => {
  await modeGroup(page).getByRole("button", { name: modeNames[mode], exact: true, pressed: true }).waitFor()
  assert.equal(await modeGroup(page).getByRole("button", { pressed: true }).count(), 1)
}
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
          if (reject) return route.fulfill({ status: 409, json: { code: "PERMISSION_BLOCK_UNVERIFIED" } })
          const body = route.request().postDataJSON()
          assert.deepEqual(body, { mode: "supervised" })
          await held
          mode = body.mode
          permissionUpdate(id)
        } else if (index === 1 && failOtherReads && id === "ses_child") {
          return route.fulfill({ status: 503 })
        }
        return route.fulfill({ json: id === "ses_child" ? { mode, rootSessionID: "ses_status" }
          : { mode: id === "ses_status" ? mode : "autonomous" } })
      })
      await events.route(page)
      await page.goto(url)
      if (index === 1) await page.evaluate(() => (window as any).statusFixture.select("ses_child"))
      await statusTab(page).click()
      await page.waitForFunction(() => (window as any).statusFixture?.streamOpens() > 0)
      await expectMode(page, "autonomous")
    }))
    const [first, other] = pages
    assert.deepEqual((await sectionIds(first)).slice(0, 3), ["tokens", "permissions", "provider-usage"])
    const autonomous = modeButton(first, "autonomous")
    const supervised = modeButton(first, "supervised")
    const [left, right, group] = await Promise.all([autonomous.boundingBox(), supervised.boundingBox(), modeGroup(first).boundingBox()])
    assert.ok(left && right && group)
    assert.equal(left.width, right.width)
    assert.equal(left.y, right.y)
    assert.equal(left.x + left.width, right.x)
    assert.equal(left.width + right.width, group.width)
    await autonomous.locator("svg.lucide-zap").waitFor()
    await supervised.locator("svg.lucide-shield").waitFor()
    const fill = (button: Locator) => button.evaluate(element => getComputedStyle(element).backgroundColor)
    assert.notEqual(await fill(autonomous), await fill(supervised))
    const status = permissionSection(first).getByRole("status")
    await status.filter({ hasText: "Permissions: Autonomous" }).waitFor({ state: "attached" })
    assert.equal(await permissionTrigger(first).locator(".right-panel-section-summary").count(), 0)
    await autonomous.focus()
    await first.keyboard.press("Tab")
    await expectFocus(supervised)
    assert.equal(await supervised.evaluate(element => getComputedStyle(element).outlineStyle), "solid")
    await first.keyboard.press("Space")
    await expectMode(first, "autonomous")
    await status.filter({ hasText: "Updating permissions…" }).waitFor({ state: "attached" })
    await expectFocus(supervised)
    await first.keyboard.press("Enter")
    assert.equal(attempts, 1, "activating the pending button again does not issue another write")
    const otherTrigger = permissionTrigger(other)
    await otherTrigger.click()
    await modeGroup(other).waitFor({ state: "hidden" })
    await otherTrigger.locator(".lucide-zap").waitFor()
    await permissionSection(other).getByRole("button", { name: "Permissions Autonomous", exact: true }).waitFor()
    release()
    await expectMode(first, "supervised")
    await otherTrigger.locator(".lucide-shield").waitFor()
    await permissionSection(other).getByRole("button", { name: "Permissions Supervised", exact: true }).waitFor()
    await status.filter({ hasText: "Permissions: Supervised" }).waitFor({ state: "attached" })

    const otherSection = permissionSection(other)
    const stale = otherSection.getByRole("status").filter({ hasText: "Mode not confirmed." })
    const reload = otherSection.getByRole("button", { name: "Reload permissions" })
    failOtherReads = true
    mode = "autonomous"
    permissionUpdate("ses_status")
    await expectMode(first, "autonomous")
    await otherTrigger.getByText("Mode not confirmed.").waitFor()
    await otherTrigger.locator(".lucide-shield").waitFor()
    await otherTrigger.click()
    await stale.waitFor()
    await expectMode(other, "supervised")
    assert.equal(await modeGroup(other).getAttribute("aria-disabled"), "true")
    failOtherReads = false
    await reload.click()
    await expectMode(other, "autonomous")
    await stale.waitFor({ state: "hidden" })

    await supervised.click()
    await expectMode(first, "supervised")
    await expectMode(other, "supervised")
    reject = true
    await autonomous.click()
    await first.getByRole("alert").filter({ hasText: "Can’t switch to Autonomous: the rules to remove couldn’t be verified." }).waitFor()
    await expectMode(first, "supervised")
    assert.equal(attempts, 3, "reconciliation never replays the write")

    await first.evaluate(() => (window as any).statusFixture.select("ses_other"))
    await expectMode(first, "autonomous")
    await first.evaluate(() => (window as any).statusFixture.select("ses_status"))
    await expectMode(first, "supervised")
    mode = "autonomous"
    await other.route("**/permission-mode", async route => {
      if (route.request().method() !== "GET") return route.fallback()
      await reconnectRead
      return route.fulfill({ json: { mode, rootSessionID: "ses_status" } })
    })
    await other.evaluate(() => (window as any).statusFixture.reconnect())
    await stale.waitFor()
    await expectMode(other, "supervised")
    assert.equal(await modeGroup(other).getAttribute("aria-disabled"), "true", "a disconnect removes confirmation before the reconnect read settles")
    allowReconnectRead()
    await expectMode(other, "autonomous")
    await stale.waitFor({ state: "hidden" })
    assert.equal(await supervised.getAttribute("aria-pressed"), "true", "no event was delivered to the original window")
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
    await dialog.getByText("This sets the family’s mode. Existing subagents keep their rules; forks have their own mode.", { exact: true }).waitFor()
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
    await expectMode(page, "autonomous")
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
    let reads = 0
    await page.route("**/permission-mode", route => {
      reads++
      return route.fulfill({ json: { mode: "autonomous" } })
    })
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
    assert.equal(reads, 0, "a hidden Permissions section has no read demand")
    await choice.check()
    await page.keyboard.press("Escape")
    await expectMode(page, "autonomous")
    assert.deepEqual((await sectionIds(page)).slice(0, 3), ["provider-usage", "permissions", "tokens"])
    await page.reload()
    await statusTab(page).click()
    await expectMode(page, "autonomous")
    assert.deepEqual((await sectionIds(page)).slice(0, 3), ["provider-usage", "permissions", "tokens"])
  } catch (error) {
    console.error(await page.locator("body").innerText())
    throw error
  } finally { await page.close() }
})

if (captures) test("Capture the French Permissions section in light and dark themes", async () => {
  for (const colorScheme of ["dark", "light"] as const) {
    const page = await openPage({ locale: "fr-FR", colorScheme })
    try {
      await page.route("**/api/**", route => new URL(route.request().url()).pathname === "/api/storage/config/ui"
        ? route.fulfill({ json: { settings: { locale: "fr" }, theme: colorScheme } })
        : statusFixtureResponse(route))
      await page.route("**/permission-mode", route => route.fulfill({ json: { mode: "supervised" } }))
      await events.route(page)
      await page.goto(url)
      await page.getByRole("tab", { name: "Statut", exact: true }).click()
      const section = permissionSection(page)
      await section.getByRole("button", { name: "Supervisé", exact: true, pressed: true }).waitFor()
      await page.locator(`html[data-theme="${colorScheme}"]`).waitFor({ state: "attached" })
      await section.screenshot({ path: join(captures, `permissions-fr-${colorScheme}-deplie.png`) })
      await permissionTrigger(page).click()
      await section.getByRole("button", { name: "Permissions Supervisé", exact: true }).waitFor()
      await page.mouse.move(500, 10)
      await section.screenshot({ path: join(captures, `permissions-fr-${colorScheme}-replie.png`) })
    } finally { await page.close() }
  }
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
