import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget, waitForMissionPanelRefresh } from "./mission-panel-route"
import type { PluginActivationMutationRequest, PluginControlsSnapshot, PluginRuntimeInventoryEntry } from "../../../server/src/api-types"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "mission-visibility",
      routes: [
        { path: "/mission-visibility", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/mission-visibility.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })
const call = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) =>
  (window as any).missionVisibility[method](arg), { method, arg })
const emptyPluginSnapshot = { location: { directory: "/fixture" }, targets: [], runtime: [], configured: { rules: [], sources: [] }, controls: [] }
const globalTarget = { scope: "global" as const, path: "/daemon/opencode.jsonc", exists: true }
function activationSnapshot(global: "default" | "disabled", override?: "enabled"): PluginControlsSnapshot {
  return { ...emptyPluginSnapshot, targets: [globalTarget], controls: [{
    id: "codenomad.missions", managedBy: "codenomad", builtin: false, global, project: override ?? "default",
    effective: override ?? global, ...(override ? { controllingRule: { scope: "project", selector: "codenomad.missions", enabled: true,
      order: 1, entryIndex: 0 } } : {}),
  }] }
}

test("a Global write waits for a fresh effective state and explains a Project override", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let global: "default" | "disabled" = "default"
  const writes: boolean[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/plugin-controls**", async route => {
      if (route.request().method() === "GET") {
        if (global === "disabled") await held
        return route.fulfill({ json: activationSnapshot(global, global === "disabled" ? "enabled" : undefined) })
      }
      const enabled = writes.length !== 0
      assert.deepEqual(route.request().postDataJSON(), { location: { directory: "/fixture" }, pluginId: "codenomad.missions", scope: "global", enabled })
      writes.push(enabled)
      global = enabled ? "default" : "disabled"
      return route.fulfill({ json: { snapshot: activationSnapshot(global), target: globalTarget, rule: enabled ? "codenomad.missions" : "-codenomad.missions",
        changed: true, reloadPending: true } })
    })
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await call(page, "activate", true)
    const tab = page.getByRole("tab", { name: "Missions", exact: true })
    await tab.waitFor()
    const customize = page.getByRole("button", { name: "Customize right panel" })
    await customize.click()
    await page.getByRole("checkbox", { name: "Missions", exact: true }).click()
    const fresh = page.waitForRequest(request => request.method() === "GET" && request.url().includes("/plugin-controls?"), { timeout: 4500 })
    await page.locator(".alert-dialog").getByRole("button", { name: "Confirm", exact: true }).click()
    await fresh
    assert.equal(await tab.count(), 1, "the write acknowledgement does not hide the tab before the effective read")
    release()
    if (!await page.getByRole("checkbox", { name: "Missions", exact: true }).count()) await customize.click()
    const info = page.getByRole("button", { name: "Project rule decides Missions here.", exact: true })
    await info.press("Enter")
    await page.getByText("Project rule decides Missions here. Global: off.", { exact: true }).waitFor()
    const checkbox = page.getByRole("checkbox", { name: "Missions", exact: true })
    assert.equal(await checkbox.isChecked(), true)
    await page.keyboard.press("Escape")
    if (!await checkbox.count()) await customize.click()
    await checkbox.click()
    await info.waitFor({ state: "detached" })
    assert.equal(await checkbox.isChecked(), true)
    assert.deepEqual(writes, [false, true], "the checked effective state does not trap the Global switch off")
  } finally { release(); await page.close() }
})

test("disabling the open Missions settings selects General and re-enabling preserves its palette draft", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let global: "default" | "disabled" = "default"
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/plugin-controls**", route => route.fulfill({ json: activationSnapshot(global) }))
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await call(page, "activate", true)
    await call(page, "settings", true)
    const nav = page.locator(".settings-screen-nav-list")
    const missions = nav.getByRole("button", { name: "Missions", exact: true })
    await missions.click()
    await page.locator(".mission-preferences").waitFor()
    global = "disabled"
    await call(page, "event", "config.updated")
    await missions.waitFor({ state: "detached" })
    await page.locator(".theme-scheme-actions button").filter({ hasText: "New" }).click()
    const draft = page.locator(".theme-scheme-name-editor input")
    await draft.fill("Unsaved palette")
    global = "default"
    await call(page, "event", "config.updated")
    await missions.waitFor()
    assert.equal(await call(page, "settingsSection"), "general")
    assert.equal(await draft.inputValue(), "Unsaved palette")
  } finally { await page.close() }
})

test("Missions defaults are editable with no project open", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let reads = 0
  try {
    await page.route("**/api/**", route => {
      if (route.request().url().includes("/subagent-depth")) reads++
      const body = route.request().postDataJSON()
      return route.fulfill({ json: body?.patch ?? body ?? {} })
    })
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await call(page, "activate", true)
    await call(page, "settings", "global")
    await page.locator(".settings-screen-nav-list").getByRole("button", { name: "Missions", exact: true }).click({ timeout: 4500 })
    const deletion = page.getByRole("checkbox", { name: "Deleting a mission also deletes its task conversations" })
    assert.equal(await deletion.isEnabled(), true)
    const delegation = page.getByRole("combobox", { name: "Task sessions", exact: true })
    assert.equal(await delegation.isEnabled(), true)
    const saved = (key: string, value: unknown) => page.waitForResponse(response => {
      const request = response.request()
      if (!response.ok() || request.method() !== "PATCH" || new URL(request.url()).pathname !== "/api/storage/config/ui") return false
      const body = request.postDataJSON()
      return (JSON.stringify((body?.patch ?? body)?.settings?.[key]) ?? "").includes(JSON.stringify(value))
    })
    await Promise.all([saved("missionProfileDefaults", "independent"), delegation.selectOption("independent")])
    await Promise.all([saved("missionDeleteSessions", true), deletion.check()])
    assert.equal(reads, 0, "project depth needs a workspace")
  } finally { await page.close() }
})

test("an unknown Missions state stays hidden and reopening retries the failed read", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let fail = true, reads = 0
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/plugin-controls**", route => {
      reads++
      return fail ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: {
        ...emptyPluginSnapshot, targets: [{ scope: "global", path: "/daemon/opencode.jsonc", exists: true }],
        controls: [{ id: "codenomad.missions", managedBy: "codenomad", builtin: false, effective: "disabled", global: "disabled", project: "default" }],
      } })
    })
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    const refused = page.waitForResponse(response => response.url().includes("/plugin-controls?") && response.status() === 503)
    await call(page, "activate", true)
    await refused
    await page.getByRole("tab", { name: "Status", exact: true }).waitFor()
    const customize = page.getByRole("button", { name: "Customize right panel" })
    const checkbox = page.getByRole("checkbox", { name: "Missions", exact: true })
    await customize.click()
    assert.equal(await checkbox.isChecked(), false)
    assert.equal(await checkbox.evaluate(node => (node as HTMLInputElement).indeterminate), true)
    assert.equal(await page.getByRole("tab", { name: "Missions", exact: true }).count(), 0)
    await page.getByRole("button", { name: "Try again", exact: true }).waitFor()
    await customize.click()
    fail = false
    const retried = page.waitForResponse(response => response.url().includes("/plugin-controls?") && response.ok())
    await customize.click()
    await retried
    await page.waitForFunction(() => [...document.querySelectorAll("label")].some(label =>
      label.textContent === "Missions" && !!label.querySelector("input:not(:disabled)")))
    assert.equal(await checkbox.isChecked(), false)
    assert.equal(await checkbox.evaluate(node => (node as HTMLInputElement).indeterminate), false)
    assert.ok(reads >= 2)
  } finally { await page.close() }
})

test("Missions checkbox writes Global activation and follows manual changes without a managed-plugin warning", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const pluginId = "codenomad.missions", location = { directory: "/fixture" }
  const target = { scope: "global" as const, path: "/daemon/opencode.jsonc", exists: true }
  let enabled = true, failed = false, refuse = false
  const writes: PluginActivationMutationRequest[] = []
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const snapshot = (): PluginControlsSnapshot => {
    const runtime: PluginRuntimeInventoryEntry[] = !enabled ? [] : [{
      key: pluginId, id: pluginId, managedBy: "codenomad", source: { type: "local", path: "/daemon/plugins/codenomad-missions.ts" },
      features: { server: true }, state: failed ? { status: "failed", error: "Broken plugin" } : { status: "active" },
    }]
    const state = enabled ? "default" : "disabled"
    return { location, targets: [target], runtime, configured: { rules: [], sources: [] },
      controls: [{ id: pluginId, managedBy: "codenomad", builtin: false, effective: state, global: state, project: "default", runtime: runtime[0] }] }
  }
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await missionsRoute(page, () => 1)
    await page.route("**/api/workspaces/mission-visibility/plugin-controls**", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: snapshot() })
      const request: PluginActivationMutationRequest = route.request().postDataJSON()
      writes.push(request)
      if (refuse) return route.fulfill({ status: 403, json: { error: "OpenCode's plugin order cannot reach this activation state" } })
      enabled = request.enabled
      return route.fulfill({ json: { snapshot: snapshot(), target, rule: enabled ? pluginId : `-${pluginId}`, changed: true, reloadPending: true } })
    })
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await call(page, "activate", true)
    const tab = page.getByRole("tab", { name: "Missions", exact: true })
    const customize = page.getByRole("button", { name: "Customize right panel" })
    const popup = page.getByRole("group", { name: "Customize right panel" })
    const checkbox = popup.getByRole("checkbox", { name: "Missions", exact: true })
    const dialog = page.locator(".alert-dialog")
    const attention = page.locator('[data-system-plugin="id:codenomad.missions"]')
    await customize.click()
    await checkbox.click()
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(await tab.count(), 1)
    assert.deepEqual(writes, [])

    if (!await popup.count()) await customize.click()
    await checkbox.click()
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click()
    await tab.waitFor({ state: "detached" })
    assert.equal(await page.locator(".mission-control").count(), 0)
    assert.deepEqual(writes, [{ location, pluginId, scope: "global", enabled: false }])

    await call(page, "settings", true)
    await page.getByRole("navigation", { name: "Settings sections" }).waitFor()
    assert.equal(await page.locator(".settings-screen-nav-list").getByRole("button", { name: "Missions", exact: true }).count(), 0)
    await call(page, "settings", false)
    await page.getByRole("tab", { name: "Status", exact: true }).click()
    await page.locator(".plugin-controls-header").waitFor()
    assert.equal(await attention.count(), 0, "intentional disable is not a plugin problem")

    await customize.click()
    assert.equal(await checkbox.isChecked(), false)
    await popup.getByRole("button", { name: "Reset", exact: true }).click()
    assert.equal(await checkbox.isChecked(), false, "layout reset leaves activation alone")
    refuse = true
    await checkbox.click()
    await dialog.getByText("Could not save Missions in Global.", { exact: true }).waitFor()
    assert.equal(await tab.count(), 0)
    await dialog.getByText("OK", { exact: true }).click()
    refuse = false
    if (!await popup.count()) await customize.click()
    await checkbox.click()
    await tab.waitFor()
    assert.deepEqual(writes.slice(1), [
      { location, pluginId, scope: "global", enabled: true },
      { location, pluginId, scope: "global", enabled: true },
    ])

    enabled = false
    await call(page, "event", "config.updated")
    await tab.waitFor({ state: "detached" })
    assert.equal(await checkbox.isChecked(), false)
    enabled = true
    failed = true
    await call(page, "event", "plugin.updated")
    await tab.waitFor()
    assert.equal(await checkbox.isChecked(), true)
    await attention.waitFor()
    assert.match(await attention.innerText(), /Failed/)
    assert.equal(writes.length, 3, "manual edits reconcile without a compensating mutation")
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ writes, errors, body: (await page.locator("body").innerText()).slice(0, 3000) })
    throw error
  } finally { await page.close() }
})

test("actual mounted RightPanel suspends hidden Mission demand and refreshes native status only when visible", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let requests = 0
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/plugin-controls**", route => route.fulfill({ json: emptyPluginSnapshot }))
    await page.route("**/api/workspaces/mission-visibility/missions", route => {
      if (new URL(route.request().url()).searchParams.get("panelSource") === "summaries") requests += 1
      return route.fulfill({ json: { available: true, version: 1, projectID: "fixture", missions: [],
        generatedAt: requests, discardedEvents: 0, activity: { generatedAt: requests, missions: [] } } })
    })
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await call(page, "warmActivation")
    await page.locator(".mission-control").waitFor({ state: "attached" })
    await call(page, "restoration", false)
    assert.equal(await page.locator(".mission-control").count(), 1, "Missions is mounted, not unmounted to simulate hiding")
    assert.deepEqual(await call(page, "demanded"), [])
    await call(page, "event", "session.execution.started")
    await page.waitForTimeout(120)
    assert.equal(requests, 0)

    const shown = waitForMissionPanelRefresh(page)
    await call(page, "activate", true)
    await shown
    await page.waitForFunction(() => (window as any).missionVisibility.state().status !== "loading")
    assert.equal((await call(page, "state")).status, "ready", JSON.stringify(await call(page, "state")))
    assert.match(await page.locator(".mission-control").innerText(), /No missions yet/)
    assert.equal(requests, 1, "loading/ready state does not retrigger visibility demand")
    assert.deepEqual(await call(page, "demanded"), ["mission-visibility"])
    const status = waitForMissionPanelRefresh(page)
    await call(page, "event", "session.execution.started")
    await status
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.equal(requests, 2)
    await call(page, "event", "session.text.delta")
    await page.waitForTimeout(120)
    assert.equal(requests, 2)

    // Cancel an already-scheduled invalidation on hide, then another hidden event.
    await call(page, "event", "session.execution.started")
    await call(page, "activate", false)
    await call(page, "event", "session.execution.started")
    await page.waitForTimeout(120)
    assert.equal(requests, 2)
    assert.equal(await page.locator(".mission-control").count(), 1)
    assert.deepEqual(await call(page, "demanded"), [])
    const restored = waitForMissionPanelRefresh(page)
    await call(page, "activate", true)
    await restored
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.equal(requests, 3)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

const missionsRoute = (page: Page, onRequest: () => number, delay = 0) => page.route("**/api/workspaces/mission-visibility/missions", async route => {
  const count = new URL(route.request().url()).searchParams.get("panelSource") === "summaries" ? onRequest() : 0
  if (delay) await new Promise(resolve => setTimeout(resolve, delay))
  return route.fulfill({ json: { available: true, version: 1, projectID: "fixture", missions: [],
    generatedAt: count, discardedEvents: 0, activity: { generatedAt: count, missions: [] } } })
})

test("a visible Missions tab waits for session-list restoration, then revalidates once", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let requests = 0
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/plugin-controls**", route => route.fulfill({ json: emptyPluginSnapshot }))
    await missionsRoute(page, () => ++requests)
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await call(page, "activate", true)
    await call(page, "event", "session.execution.started")
    await page.waitForTimeout(150)
    assert.equal(requests, 0, "no Missions read before the session list starts restoring")
    assert.deepEqual(await call(page, "demanded"), [])

    await call(page, "restoration", true)
    await call(page, "event", "rpc.codenomad.missions.changed")
    await page.waitForTimeout(150)
    assert.equal(requests, 0, "restoration keeps priority while it runs")

    const shown = waitForMissionPanelRefresh(page)
    await call(page, "restoration", false)
    await shown
    await page.getByText("No missions yet", { exact: true }).waitFor()
    assert.deepEqual(await call(page, "demanded"), ["mission-visibility"])
    // A later list refresh does not withdraw established demand.
    await call(page, "restoration", true)
    await page.waitForTimeout(150)
    assert.equal(requests, 1)
    assert.deepEqual(await call(page, "demanded"), ["mission-visibility"])
  } finally { await page.close() }
})

test("continuous native activity of a large family is revalidated at a bounded rate", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let requests = 0
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/workspaces/mission-visibility/plugin-controls**", route => route.fulfill({ json: emptyPluginSnapshot }))
    // The server projection is slow while the family is busy.
    await missionsRoute(page, () => ++requests, 150)
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).missionVisibility))
    await call(page, "restoration", false)
    const shown = waitForMissionPanelRefresh(page)
    await call(page, "activate", true)
    await shown
    await page.waitForFunction(() => (window as any).missionVisibility.state().status === "ready")

    // A busy family: status events keep arriving, spaced beyond the debounce.
    const first = waitForMissionPanelRefresh(page)
    for (let index = 0; index < 16; index++) {
      await call(page, "event", "session.execution.started")
      await page.waitForTimeout(100)
    }
    await first
    await page.waitForTimeout(400)
    assert.equal(requests, 2, "the storm coalesces into one read, never one per event or a back-to-back loop")

    // Journal changes stay prompt even while activity is throttled.
    const changed = waitForMissionPanelRefresh(page)
    await call(page, "event", "rpc.codenomad.missions.changed")
    await changed
    assert.equal(requests, 3)
  } finally { await page.close() }
})
