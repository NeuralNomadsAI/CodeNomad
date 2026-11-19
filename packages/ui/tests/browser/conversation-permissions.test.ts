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
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await Promise.all(pages.map(async (page) => {
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

    const info = first.getByRole("button", { name: "About permission modes" })
    await info.focus()
    await first.keyboard.press("Enter")
    await first.getByText("New subagents inherit these rules.", { exact: true }).waitFor()
    if (captures) await first.getByRole("dialog").screenshot({ path: join(captures, "status-permissions-info.png") })
    await first.keyboard.press("Escape")
    await first.getByText("New subagents inherit these rules.", { exact: true }).waitFor({ state: "hidden" })
    await first.waitForFunction(el => el === document.activeElement, await info.elementHandle())

    reject = true
    await select.selectOption("autonomous")
    await first.getByText("Couldn’t change permissions. Try again.", { exact: true }).waitFor()
    assert.equal(await select.inputValue(), "supervised")
    assert.equal(attempts, 2, "reconciliation never replays the write")

    await first.evaluate(() => (window as any).statusFixture.select("ses_other"))
    await expectValue(select, "autonomous")
    await first.evaluate(() => (window as any).statusFixture.select("ses_status"))
    await expectValue(select, "supervised")
    mode = "autonomous"
    await other.evaluate(() => (window as any).statusFixture.reconnect())
    await expectValue(modeSelect(other), "autonomous")
    assert.equal(await select.inputValue(), "supervised", "no event was delivered to the original window")
  } catch (error) {
    console.error(await pages[0].locator("body").innerText())
    throw error
  } finally { release?.(); await Promise.all(pages.map(page => page.close())) }
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
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/storage/config/ui", route => {
      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON()
        assert.deepEqual(patch, { settings: { newConversationPermissions: "supervised" } })
        if (reject) return route.fulfill({ status: 503 })
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
    await setting.getByText("Supervised", { exact: true }).waitFor()
    assert.equal(value, "supervised")
    await page.reload()
    await setting.getByText("Supervised", { exact: true }).waitFor()
    if (captures) await page.locator(".settings-card").filter({ has: setting }).screenshot({ path: join(captures, "preferences-new-conversations.png") })
  } catch (error) {
    console.error(await page.locator("body").innerText())
    throw error
  } finally { await page.close() }
})
