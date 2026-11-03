import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { integrationView, routeIntegrations, waitFor } from "./integration-status-model"

let browser: Browser, url: string
const screenshots = process.env.CODENOMAD_INTEGRATION_SCREENSHOTS
before(async () => {
  const fixture = await borrowFixture({ name: "integration-status-section", routes: [{ path: "/integration-status", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/integration-status-section.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  if (screenshots) mkdirSync(screenshots, { recursive: true })
})
after(async () => { await browser?.close() })

type Routes = Awaited<ReturnType<typeof routeIntegrations>>
const fx = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(([name, values]) => (window as any).integrationStatus[name as string](...(values as unknown[])), [method, args] as const)

async function open(prepare?: (routes: Routes) => void, options: { width?: number; dark?: boolean; locale?: string; clock?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: options.width ?? 420, height: 1000 }, colorScheme: options.dark ? "dark" : "light" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => { if (!localStorage.getItem("opencode-session-right-panel-tab-v2")) localStorage.setItem("opencode-session-right-panel-tab-v2", "status") })
  // Native events are dispatched explicitly; no incidental transport status changes.
  // tsx names page functions with a page-absent `__name`.
  await page.addInitScript("window.__name = f => f")
  await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
  if (options.clock) await page.clock.install()
  const routes = await routeIntegrations(page)
  readCounts.set(page, () => routes.count("read"))
  prepare?.(routes)
  await page.goto(`${url}${options.locale ? `?locale=${options.locale}` : ""}`)
  // The fixture boot (module graph, i18n) is load-sensitive; the interactions below keep the default bound.
  await page.waitForFunction(() => Boolean((window as any).integrationStatus), undefined, { timeout: 30_000 })
  return { page, errors, ...routes }
}

const section = (page: Page, id: string) => page.locator(`[data-status-section="integration:${id}"]`)
const trigger = (page: Page, id: string) => page.locator(`[data-status-section-trigger="integration:${id}"]`)
const body = (page: Page, id: string) => page.locator(`[data-integration-section="${id}"]`)
const label = (page: Page, id: string) => section(page, id).locator("[data-integration-state]").first()
const conversation = (page: Page, id: string) => body(page, id).locator('[data-line="conversation"]')
const action = (page: Page, id: string) => conversation(page, id).locator("[data-conversation-action]")
const sectionIds = (page: Page) => page.locator("[data-status-section]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-status-section")))
async function expand(page: Page, id: string) {
  await trigger(page, id).waitFor()
  if (await trigger(page, id).getAttribute("aria-expanded") !== "true") await trigger(page, id).click()
  await body(page, id).waitFor()
}
async function collapse(page: Page, id: string) {
  if (await trigger(page, id).getAttribute("aria-expanded") === "true") await trigger(page, id).click()
}
const readCounts = new WeakMap<Page, () => number>()
/** The routes changed: OpenCode's payload-free event makes the panel read again (coalesced over 300 ms). */
async function notify(page: Page, type = "rpc.neuralnomads.blender.status_changed") {
  const reads = readCounts.get(page)!, before = reads()
  await fx(page, "event", type)
  await waitFor(() => reads() > before, "the coalesced re-read", 10_000)
  await page.waitForTimeout(150)
}
async function waitLabel(page: Page, id: string, text: string) {
  await page.waitForFunction(([selector, expected]) => document.querySelector(selector)?.textContent === expected,
    [`[data-status-section="integration:${id}"] [data-integration-state]`, text] as const)
}
/** The shared guarded confirmation (alert-dialog.tsx), named by its title. */
const confirmation = (page: Page, title: RegExp) => page.locator(".alert-dialog").filter({ has: page.locator("h2", { hasText: title }) })

test("AC-E5 one section per declared or loaded integration, in catalogue order after Plugins; none for a rule alone or an ambiguous source", async () => {
  const { page, errors, model } = await open(routes => {
    routes.model.integrations.push(
      integrationView("resolve", { family: "vendor-mcp", plugin: { declared: false }, configured: false, configuredSources: [], state: "absent", status: undefined, version: undefined }),
      integrationView("houdini", { plugin: { declared: false }, configured: true, configuredSources: [], state: "inactive", status: undefined, version: undefined }),
      integrationView("unreal", { ambiguous: true, plugin: { declared: false }, configuredSources: [], state: "non-conforming", status: undefined }),
    )
    routes.model.ambiguousSources = [{ scope: "global", entryIndex: 1 }]
  })
  try {
    await trigger(page, "gaffer").waitFor()
    const ids = await sectionIds(page)
    const plugins = ids.indexOf("plugins")
    assert.deepEqual(ids.slice(plugins), ["plugins", "integration:blender", "integration:gaffer"], "exactly two integration sections right after Plugins")
    assert.equal(await trigger(page, "blender").locator(".section-label").innerText(), "OpenCode for Blender")
    for (const id of ["resolve", "houdini", "unreal"]) assert.equal(await section(page, id).count(), 0, id)
    // The ambiguous source keeps its Plugins row, labelled non-conforming; the integrations keep theirs too.
    await page.locator('[data-plugin-id="other.plugin"] [data-integration-state="nonConforming"]').waitFor()
    assert.equal(await page.locator('[data-plugin-id="neuralnomads.blender"] [data-integration-state]').count(), 0)
    assert.equal(await page.locator('[data-plugin-id="neuralnomads.blender"]').count(), 1)

    // Installed elsewhere: the section appears without reload, and is announced once.
    model.integrations[2] = integrationView("resolve", { family: "vendor-mcp", status: { version: "1.0.0", connection: { state: "connected" } } })
    await notify(page)
    await trigger(page, "resolve").waitFor()
    assert.deepEqual((await sectionIds(page)).slice(plugins), ["plugins", "integration:blender", "integration:gaffer", "integration:resolve"])
    await page.waitForFunction(() => document.querySelector("[data-integration-announcements]")?.textContent?.includes("OpenCode for Resolve added to Status"))
    // A version, scope or spec change keeps the ID; a removal removes the section.
    model.integrations[0] = integrationView("blender", { version: "0.2.0", configuredSources: [{ scope: "project", entryIndex: 0 }], scopes: ["project"] })
    await notify(page)
    assert.equal(await trigger(page, "blender").count(), 1)
    model.integrations.splice(0, 1)
    await notify(page)
    await trigger(page, "blender").waitFor({ state: "detached" })
    await page.waitForFunction(() => document.querySelector("[data-integration-announcements]")?.textContent?.includes("OpenCode for Blender removed from Status"))
    // Disabled, failed, pending and marker-mismatch integrations keep their section.
    for (const [state, plugin] of [["inactive", { declared: true }], ["failed", { declared: true, runtime: "failed" }], ["non-conforming", { declared: true, runtime: "loaded" }]] as const) {
      model.integrations[0] = integrationView("gaffer", { state, plugin, status: undefined })
      await notify(page)
      assert.equal(await trigger(page, "gaffer").count(), 1, state)
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("AC-E6 hiding and order persist across reloads and absence; Up/Down reorders every Status section with focus kept (AC-E3)", async () => {
  const { page, model } = await open()
  try {
    await trigger(page, "gaffer").waitFor()
    const customize = page.getByRole("button", { name: "Customize right panel", exact: true })
    await customize.click()
    const popup = page.getByRole("group", { name: "Customize right panel", exact: true })
    if (screenshots) await page.screenshot({ path: join(screenshots, "status-customization.png"), fullPage: true })
    const labels = await popup.locator("[data-status-section-toggle]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-status-section-toggle")))
    assert.deepEqual(labels, ["tokens", "yolo-mode", "provider-usage", "background-processes", "mcp", "plugins", "integration:blender", "integration:gaffer"])
    await popup.getByRole("checkbox", { name: "OpenCode for Blender", exact: true }).uncheck()
    await trigger(page, "blender").waitFor({ state: "detached" })
    // Keyboard reorder: a core section and an integration section, focus stays on the moved row.
    const gaffer = popup.getByRole("checkbox", { name: "OpenCode for Gaffer", exact: true })
    await gaffer.focus()
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("ArrowUp")
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-status-section-toggle") === "integration:gaffer")
    const tokens = popup.getByRole("checkbox", { name: "Tokens", exact: true })
    await tokens.focus()
    await page.keyboard.press("ArrowDown")
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-status-section-toggle") === "tokens")
    const saved = await fx(page, "customization")
    assert.deepEqual(saved.hiddenStatusSectionIds, ["integration:blender"])
    assert.deepEqual(saved.statusSectionOrder, ["yolo-mode", "tokens", "provider-usage", "background-processes", "mcp", "integration:gaffer", "plugins", "integration:blender"])
    await page.keyboard.press("Escape")

    await page.reload()
    await trigger(page, "gaffer").waitFor()
    assert.equal(await trigger(page, "blender").count(), 0, "hidden after reload")
    let ids = await sectionIds(page)
    assert.ok(ids.indexOf("integration:gaffer") < ids.indexOf("plugins"), "order kept after reload")

    // Momentarily unrecognised: another reorder keeps its ID; recognised again, it takes back its place.
    model.integrations.splice(1, 1)
    await notify(page)
    await trigger(page, "gaffer").waitFor({ state: "detached" })
    await customize.click()
    await popup.getByRole("checkbox", { name: "MCP Servers", exact: true }).focus()
    await page.keyboard.press("ArrowUp")
    const during = await fx(page, "customization")
    assert.ok(during.statusSectionOrder.includes("integration:gaffer"), "an absent integration keeps its rank")
    assert.ok(during.hiddenStatusSectionIds.includes("integration:blender"))
    await page.keyboard.press("Escape")
    model.integrations.push(integrationView("gaffer"))
    await notify(page)
    await trigger(page, "gaffer").waitFor()
    ids = await sectionIds(page)
    assert.ok(ids.indexOf("integration:gaffer") < ids.indexOf("plugins"))
    // Unhidden, Blender takes back its saved position after Plugins.
    await customize.click()
    await popup.getByRole("checkbox", { name: "OpenCode for Blender", exact: true }).check()
    await trigger(page, "blender").waitFor()
    ids = await sectionIds(page)
    assert.equal(ids.indexOf("integration:blender"), ids.indexOf("plugins") + 1)
  } finally { await page.close() }
})

const stateCases: Array<{ name: string; label: string; view?: Record<string, unknown>; expanded: boolean; lines: string[]; check?: (page: Page) => Promise<void> }> = [
  { name: "ready", label: "Ready", view: { status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 0 } } }, expanded: false, lines: ["plugin", "application", "conversation"] },
  { name: "application part missing", label: "Application part missing", view: { status: { version: "0.1.0", host: { state: "absent", action: "install" }, connection: { offers: 0 } } },
    expanded: true, lines: ["plugin", "application", "conversation"], check: async page => {
      await body(page, "blender").getByRole("button", { name: "Install in application…", exact: true }).waitFor()
      assert.equal(await body(page, "blender").locator("[data-application-state]").innerText(), "Missing")
    } },
  { name: "available", label: "Application available", expanded: false, lines: ["plugin", "application", "conversation"] },
  { name: "application update", label: "Application update needed", view: { status: { version: "0.1.0", host: { state: "outdated", action: "update" }, connection: { offers: 0 } } },
    expanded: true, lines: ["plugin", "application", "conversation"], check: async page => {
      await body(page, "blender").getByRole("button", { name: "Update application…", exact: true }).waitFor()
    } },
  { name: "application closed", label: "Application closed", view: { status: { version: "0.1.0", host: { state: "unknown" }, connection: { offers: 0 } } }, expanded: false, lines: ["plugin", "application", "conversation"] },
  { name: "incompatible", label: "Incompatible", view: { status: { version: "0.1.0", host: { state: "incompatible" }, connection: { offers: 0 } } }, expanded: true, lines: ["plugin", "application", "conversation"] },
  { name: "legacy install", label: "Legacy install", view: { status: { version: "0.1.0", host: { state: "ok" }, notices: ["legacy_install"], connection: { offers: 0 } } },
    expanded: false, lines: ["plugin", "application", "conversation"], check: async page => {
      await expand(page, "blender")
      await body(page, "blender").getByRole("button", { name: "Guide", exact: true }).waitFor()
    } },
  { name: "failed", label: "Failed", view: { state: "failed", plugin: { declared: true, runtime: "failed" }, status: undefined, version: undefined }, expanded: true, lines: ["plugin"] },
  { name: "unsupported", label: "Not supported", view: { state: "unsupported", status: undefined }, expanded: false, lines: ["plugin"] },
  { name: "install not confirmed", label: "Install not confirmed", view: { state: "inactive", plugin: { declared: true }, status: undefined, version: undefined }, expanded: true, lines: ["plugin"],
    check: async page => { await body(page, "blender").getByRole("button", { name: "Refresh", exact: true }).waitFor() } },
  { name: "non-conforming", label: "Non-conforming", view: { state: "non-conforming", status: undefined }, expanded: false, lines: ["plugin"] },
  { name: "unknown", label: "Unknown", view: { state: "unknown", status: undefined }, expanded: false, lines: ["plugin"] },
  { name: "update available", label: "Application available", view: { outdated: true }, expanded: false, lines: ["plugin", "application", "conversation"], check: async page => {
    await section(page, "blender").locator('[data-integration-state="update"]').waitFor()
    await expand(page, "blender")
    await body(page, "blender").getByText("Update available", { exact: true }).waitFor()
  } },
]

test("AC-E1 every section state shows its label, its family's lines and its action; collapsed unless an action is expected", async () => {
  const { page, errors, model } = await open(routes => {
    routes.model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 1, attachedSessions: 42, state: "attached" } } })
  })
  try {
    await trigger(page, "blender").waitFor()
    for (const entry of stateCases) {
      await collapse(page, "blender")
      model.integrations[0] = integrationView("blender", entry.view ?? {})
      await notify(page)
      await waitLabel(page, "blender", entry.label)
      assert.equal(await trigger(page, "blender").getAttribute("aria-expanded"), String(entry.expanded), `${entry.name} expanded`)
      await expand(page, "blender")
      const lines = await body(page, "blender").locator("[data-line]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-line")))
      assert.deepEqual(lines, entry.lines, `${entry.name} lines`)
      await entry.check?.(page)
      const text = await body(page, "blender").innerText()
      assert.equal(/\b42\b|attachedSessions/.test(text), false, `${entry.name}: no aggregate binding count`)
      for (const line of text.split("\n")) assert.ok(line.length <= 60, `${entry.name}: terse line "${line}"`)
    }
    // Other families: a Connection line, no Application or Conversation line.
    model.integrations[1] = integrationView("gaffer", { family: "vendor-mcp", app: { name: "Gaffer", versions: ">=21.1" }, status: { version: "1.0.0", connection: { state: "none" } } })
    await notify(page)
    await expand(page, "gaffer")
    assert.deepEqual(await body(page, "gaffer").locator("[data-line]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-line"))), ["plugin", "connection"])
    assert.equal(await body(page, "gaffer").locator("[data-connection-state]").innerText(), "Server not found")
    await body(page, "gaffer").getByRole("button", { name: "Requires Gaffer >=21.1", exact: true }).waitFor()
    model.integrations[1] = integrationView("gaffer", { family: "api", status: { version: "1.0.0", connection: { state: "connected" } } })
    await notify(page)
    await page.waitForFunction(() => document.querySelector('[data-integration-section="gaffer"] [data-connection-state]')?.textContent === "Connected")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("AC-E1 Conversation line: no conversation, no offer, available, reattach, attached, unknown, uncertain and unsupported", async () => {
  const { page, model, count } = await open()
  try {
    await expand(page, "blender")
    const state = () => conversation(page, "blender").locator("[data-conversation-state]")
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-state]')?.getAttribute("data-conversation-state") === "available")
    assert.equal(await action(page, "blender").innerText(), "Attach…")
    model.offers = []
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 0 } } })
    await notify(page)
    assert.equal(await state().innerText(), "No open application")
    assert.equal(await action(page, "blender").count(), 0)
    await conversation(page, "blender").getByRole("button", { name: "No open application", exact: true }).click()
    await page.getByText("Open Blender and turn on “Offer this session to OpenCode”.", { exact: true }).waitFor()
    await page.keyboard.press("Escape")
    model.integrations[0] = integrationView("blender")
    await fx(page, "hint", "blender", "Scene")
    await notify(page)
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-action]')?.textContent === "Attach…")
      .catch(async error => { await page.screenshot({ path: join(process.env.TEMP ?? ".", "row-fail.png") }); throw error })
    model.bindings["first:blender"] = { state: "attached", label: "scene.blend" }
    await notify(page)
    await waitLabel(page, "blender", "Attached")
    assert.equal(await state().innerText(), "Attached to “scene.blend”")
    assert.equal(await action(page, "blender").innerText(), "Detach")
    model.fail.set("binding", 500)
    await notify(page)
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-state]')?.textContent === "Binding unknown")
    assert.equal(await action(page, "blender").innerText(), "Refresh")
    model.fail.delete("binding")
    await fx(page, "select", null)
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-state]')?.textContent === "No conversation")
    assert.equal(await action(page, "blender").getAttribute("aria-disabled"), "true")
    assert.equal(await action(page, "blender").getAttribute("title"), "Open a conversation")
    const before = count("hosts")
    await action(page, "blender").click({ force: true })
    assert.equal(count("hosts"), before)
    await fx(page, "select", "first")
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "unsupported" }, connection: { offers: 1 } } })
    await notify(page)
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-state]')?.textContent === "Not supported")
    assert.equal(await action(page, "blender").count(), 0)
    assert.equal(count("hosts") + count("attach") + count("detach"), 0, "no attachment route under an unsupported host")
  } finally { await page.close() }
})

test("AC-E2 native actions from the section: switches, update, remove, host install, attach and one-click detach (AC-C14, AC-C16)", async () => {
  const { page, errors, model, calls, count } = await open()
  try {
    await expand(page, "blender")
    // Activation: no confirmation, one native mutation, the same state in the Plugins row.
    const sectionSwitch = body(page, "blender").getByRole("checkbox", { name: /OpenCode for Blender — Global/ })
    await sectionSwitch.click()
    await page.waitForFunction(() => (window as any).integrationStatus.mutations().length === 1)
    assert.deepEqual(await fx(page, "mutations"), [{ location: { directory: "/repo" }, pluginId: "neuralnomads.blender", scope: "global", enabled: false }])
    assert.equal(await page.locator(".alert-dialog").count(), 0)
    await page.waitForFunction(() => !(document.querySelector('[data-plugin-id="neuralnomads.blender"] [data-scope="global"] input') as HTMLInputElement)?.checked)
    assert.equal(await sectionSwitch.isChecked(), false)
    await waitLabel(page, "blender", "Disabled")
    // The Plugins row switch drives the same rule and the same section state.
    await page.locator('[data-plugin-id="neuralnomads.blender"] [data-scope="global"] input').click()
    await page.waitForFunction(() => (window as any).integrationStatus.mutations().length === 2)
    await waitLabel(page, "blender", "Application available")
    assert.equal(await sectionSwitch.isChecked(), true)
    // The native Project switch stays focusable but locked (D18).
    const project = body(page, "blender").getByRole("checkbox", { name: /OpenCode for Blender — Project/ })
    assert.equal(await project.getAttribute("aria-disabled"), "true")
    await project.click({ force: true })
    assert.equal((await fx(page, "mutations")).length, 2)
    const pluginProject = page.locator('[data-plugin-id="neuralnomads.blender"] [data-scope="project"] input')
    assert.equal(await pluginProject.getAttribute("aria-disabled"), "true", "the Plugins row shares the native Global-only constraint")
    await pluginProject.click({ force: true })
    assert.equal((await fx(page, "mutations")).length, 2)

    // Menu: Check/Update, Remove and Refresh only; Check runs at once.
    await body(page, "blender").getByRole("button", { name: "Actions for OpenCode for Blender", exact: true }).click()
    assert.deepEqual((await page.getByRole("menuitem").allInnerTexts()).map(item => item.trim()),
      ["Check updates for @neuralnomads/opencode-blender@^0.1", "Remove from Global", "Refresh plugin controls"])
    await page.getByRole("menuitem", { name: /^Check updates/ }).click()
    await page.waitForFunction(() => (window as any).integrationStatus.packageRequests().length === 1)
    assert.equal(await page.locator(".alert-dialog").count(), 0)

    // Remove (D25): the same guarded confirmation and DELETE as the Plugins row; no detach.
    const remove = async (menu: () => Promise<void>) => {
      await menu()
      await page.getByRole("menuitem", { name: "Remove from Global", exact: true }).click()
      const dialog = confirmation(page, /Remove from Global/)
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /may interrupt its availability/)
      assert.match(await dialog.innerText(), /other projects/)
      assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(element => element === document.activeElement), true)
      await page.waitForTimeout(650)
      await dialog.getByRole("button", { name: "Remove from Global", exact: true }).click()
      await dialog.waitFor({ state: "hidden" })
    }
    await remove(() => body(page, "blender").getByRole("button", { name: "Actions for OpenCode for Blender", exact: true }).click())
    await waitFor(() => count("remove") === 1, "section removal")
    await remove(() => page.locator('[data-plugin-id="neuralnomads.blender"]').getByRole("button", { name: "Actions for neuralnomads.blender", exact: true }).click())
    await waitFor(() => count("remove") === 2, "Plugins row removal")
    const removals = calls.filter(call => call.action === "remove").map(call => call.body)
    assert.deepEqual(removals[0], removals[1], "both entry points send the same request to the same service")
    assert.deepEqual(removals[0], { location: { directory: "/repo" }, scope: "global", target: "@neuralnomads/opencode-blender@^0.1", entryIndex: 2, expectedRevision: "a".repeat(64) })
    assert.equal(count("detach"), 0, "removal never detaches")

    // Host install: guarded confirmation, one empty POST.
    await collapse(page, "blender")
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "absent", action: "install" }, connection: { offers: 1 } } })
    await notify(page)
    await waitLabel(page, "blender", "Application part missing")
    await expand(page, "blender")
    await body(page, "blender").getByRole("button", { name: "Install in application…", exact: true }).click()
    const install = confirmation(page, /^Install in application…/)
    await install.waitFor()
    assert.match(await install.innerText(), /Install the Blender part of OpenCode for Blender 0\.1\.0 on the machine where OpenCode runs\?/)
    await page.waitForTimeout(650)
    await install.getByRole("button", { name: "Install in application…", exact: true }).click()
    await waitFor(() => count("install-host") === 1, "host install")
    assert.deepEqual(calls.find(call => call.action === "install-host")!.body, {})

    // Attach through the trusted picker, then one-click Detach.
    model.integrations[0] = integrationView("blender")
    await notify(page)
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-state]')?.getAttribute("data-conversation-state") === "available")
    await action(page, "blender").click()
    const picker = page.locator(".integration-attachment")
    await picker.getByText("Attach “scene.blend” (Blender 5.2) to this conversation? The agent will be able to modify it.", { exact: true }).waitFor()
    await page.waitForTimeout(650)
    await picker.getByRole("button", { name: "Attach", exact: true }).click()
    await waitFor(() => count("attach") === 1, "attach")
    assert.deepEqual(calls.find(call => call.action === "attach")!.body, { sessionID: "first", offerID: "offer-0001" })
    await picker.getByRole("button", { name: "OK", exact: true }).click()
    await waitLabel(page, "blender", "Attached")
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-action]')?.textContent === "Detach")
    await action(page, "blender").dblclick()
    await waitFor(() => count("detach") === 1, "detach")
    await page.waitForTimeout(400)
    assert.equal(count("detach"), 1, "a double click detaches once")
    assert.deepEqual(calls.find(call => call.action === "detach")!.body, { sessionID: "first" })
    assert.equal(await page.locator(".alert-dialog").count(), 0, "Detach has no confirmation (D24)")
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-action]')?.textContent === "Attach…")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("AC-C16 a lost detach answer stays uncertain until an explicit refresh, without replay", async () => {
  const { page, model, count } = await open(routes => { routes.model.bindings["first:blender"] = { state: "attached", label: "scene.blend" } })
  try {
    await waitLabel(page, "blender", "Attached")
    assert.equal(await trigger(page, "blender").getAttribute("aria-expanded"), "true", "an attached conversation expands its section")
    model.fail.set("detach", "network")
    await action(page, "blender").click()
    await waitLabel(page, "blender", "Uncertain state")
    assert.equal(await conversation(page, "blender").locator("[data-conversation-state]").innerText(), "Uncertain state")
    assert.equal(await action(page, "blender").innerText(), "Refresh")
    model.fail.delete("detach")
    await notify(page)
    await fx(page, "reconnect")
    await page.waitForTimeout(400)
    assert.equal(count("detach"), 1, "notifications and reconnects never replay")
    await waitLabel(page, "blender", "Uncertain state")
    const reads = count("binding")
    await action(page, "blender").click()
    await waitFor(() => count("binding") > reads, "explicit authoritative read")
    await waitLabel(page, "blender", "Attached")
    assert.equal(count("detach"), 1)
  } finally { await page.close() }
})

test("AC-C5 confirmations: Cancel first, <500 ms no effect, ≥600 ms confirms, Enter/double click during the delay and Cancel/Escape send nothing", async () => {
  const { page, model, count } = await open(routes => {
    routes.model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "absent", action: "install" }, connection: { offers: 1 } } })
  }, { clock: true })
  try {
    const button = body(page, "blender").getByRole("button", { name: "Install in application…", exact: true })
    await button.waitFor()
    const launch = async () => {
      await button.click()
      const dialog = confirmation(page, /^Install in application…/)
      await dialog.waitFor()
      await page.clock.runFor(20)
      await page.waitForFunction(() => document.querySelector(".alert-dialog .button-secondary") === document.activeElement)
      return { dialog, confirm: dialog.getByRole("button", { name: "Install in application…", exact: true }) }
    }
    let { dialog, confirm } = await launch()
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(element => element === document.activeElement), true)
    assert.equal(await confirm.isDisabled(), true)
    // Enter at once activates the focused Cancel: never the action.
    await page.keyboard.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    assert.equal(count("install-host"), 0)
    ;({ dialog, confirm } = await launch())
    await page.clock.fastForward(450)
    await confirm.dblclick({ force: true })
    await confirm.focus().catch(() => undefined)
    await page.keyboard.press("Enter")
    assert.equal(await dialog.isVisible(), true, "a double click or Enter before 500 ms has no effect")
    assert.equal(count("install-host"), 0)
    await page.clock.fastForward(150)
    assert.equal(await confirm.isEnabled(), true)
    assert.equal(count("install-host"), 0, "enabling never confirms")
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    ;({ dialog, confirm } = await launch())
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.equal(count("install-host"), 0, "Escape and Cancel send nothing")
    ;({ dialog, confirm } = await launch())
    await page.clock.fastForward(600)
    await confirm.click()
    await waitFor(() => count("install-host") === 1, "confirmed after 600 ms")

    // The attach picker: Cancel focused, Attach enabled only after 600 ms.
    model.integrations[0] = integrationView("blender")
    await notify(page)
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-state]')?.getAttribute("data-conversation-state") === "available")
    await action(page, "blender").click()
    const picker = page.locator(".integration-attachment")
    await picker.waitFor()
    const attach = picker.getByRole("button", { name: "Attach", exact: true })
    await page.clock.fastForward(450)
    assert.equal(await attach.isDisabled(), true)
    await page.clock.fastForward(150)
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".integration-attachment .button-primary")?.disabled)
    await picker.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(count("attach"), 0)
  } finally { await page.close() }
})

test("AC-E8 the catalogue window installs by catalogue ID after confirmation; the section then shows Installing", async () => {
  const { page, model, calls, count } = await open(routes => {
    routes.model.integrations.push(
      integrationView("resolve", { family: "vendor-mcp", plugin: { declared: false }, configured: false, configuredSources: [], state: "absent", status: undefined, version: undefined }),
      integrationView("houdini", { plugin: { declared: false }, configured: true, configuredSources: [], state: "inactive", status: undefined, version: undefined }),
    )
    routes.model.install = (_scope, id) => {
      const index = routes.model.integrations.findIndex(item => item.id === id)
      routes.model.integrations[index] = { ...routes.model.integrations[index], plugin: { declared: true }, configured: true, state: "inactive" }
    }
  })
  try {
    await trigger(page, "blender").waitFor()
    const openCatalog = async () => {
      // A hover tooltip of the Plugins row under the pointer would cover the "+".
      await page.mouse.move(0, 0)
      await page.getByRole("button", { name: "Add", exact: true }).click()
      await page.getByRole("menuitem", { name: "Add an integration…", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Add an integration" })
      await dialog.waitFor()
      return dialog
    }
    let catalog = await openCatalog()
    if (screenshots) await page.screenshot({ path: join(screenshots, "integration-catalog.png"), fullPage: true })
    assert.deepEqual(await catalog.locator("[data-catalog-integration]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-catalog-integration"))), ["resolve", "houdini"])
    const houdini = catalog.locator('[data-catalog-integration="houdini"]')
    assert.equal(await houdini.getByText("In the application", { exact: true }).count(), 1)
    const nativeScope = houdini.getByRole("combobox")
    assert.equal(await nativeScope.getAttribute("aria-disabled"), "true")
    assert.equal(await nativeScope.getAttribute("title"), "Global only")
    await catalog.getByRole("button", { name: "Close", exact: true }).first().click()
    await catalog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Add")

    catalog = await openCatalog()
    const resolve = catalog.locator('[data-catalog-integration="resolve"]')
    await resolve.getByRole("combobox").selectOption("project")
    await resolve.getByRole("button", { name: "Install — OpenCode for Resolve", exact: true }).click()
    const consent = confirmation(page, /^Install integration/)
    await consent.waitFor()
    assert.match(await consent.innerText(), /Install OpenCode for Resolve \(Project\)\? The code will run with your rights in OpenCode\./)
    assert.match(await consent.innerText(), /runs whenever this folder is opened/)
    await page.waitForTimeout(650)
    await consent.getByRole("button", { name: "Install", exact: true }).click()
    await catalog.waitFor({ state: "hidden" })
    await waitFor(() => count("install") === 1, "one install by ID")
    assert.deepEqual(calls.find(call => call.action === "install")!, { action: "install", method: "POST", integration: "resolve", directory: "/repo", body: { scope: "project" } })
    await waitLabel(page, "resolve", "Installing")

    // A lost answer is never replayed.
    model.fail.set("install", "network")
    catalog = await openCatalog()
    await catalog.locator('[data-catalog-integration="houdini"]').getByRole("button", { name: /^Install/ }).click()
    await page.waitForTimeout(650)
    await confirmation(page, /^Install integration/).getByRole("button", { name: "Install", exact: true }).click()
    await page.waitForFunction(() => JSON.stringify((window as any).integrationStatus.toasts()).includes("Not confirmed. Refresh to check."))
    await notify(page)
    assert.equal(count("install"), 2)

    // Catalogue states.
    model.catalog = { state: "stale", fetchedAt: "2026-11-01T12:00:00Z" }
    await notify(page)
    catalog = await openCatalog()
    await catalog.getByText(/^Catalogue of /).waitFor()
    await page.keyboard.press("Escape")
    model.catalog = { state: "unavailable" }
    model.integrations = model.integrations.filter(item => item.plugin.declared)
    await notify(page)
    catalog = await openCatalog()
    await catalog.getByText("Catalogue unavailable", { exact: true }).waitFor()
    await catalog.getByRole("button", { name: "Refresh", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    model.catalog = { state: "fresh", fetchedAt: "2026-11-01T12:00:00Z" }
    await notify(page)
    catalog = await openCatalog()
    await catalog.getByText("All integrations are installed.", { exact: true }).waitFor()
  } finally { await page.close() }
})

test("AC-E3 accessible structure, keyboard info button, focus fallback when a section disappears, and AA contrast in light and dark", async () => {
  for (const dark of [false, true]) {
    const { page, model } = await open(routes => { routes.model.bindings["first:blender"] = { state: "attached", label: "scene.blend" } }, { dark })
    try {
      await waitLabel(page, "blender", "Attached")
      const controls = await trigger(page, "blender").getAttribute("aria-controls")
      const region = page.locator(`[id="${controls}"]`)
      assert.equal(await region.getAttribute("role"), "region")
      assert.equal(await page.getByRole("region", { name: "OpenCode for Blender", exact: true }).count(), 1)
      // The "i" button: Enter opens the catalogue summary, Escape closes it and returns focus.
      const info = section(page, "blender").getByRole("button", { name: "About OpenCode for Blender", exact: true })
      await info.focus()
      await page.keyboard.press("Enter")
      await page.getByText("Use Blender from OpenCode.", { exact: true }).waitFor()
      await page.waitForFunction(() => document.activeElement?.closest(".info-popover-content"))
      if (screenshots) await page.screenshot({ path: join(screenshots, `section-info-${dark ? "dark" : "light"}.png`), fullPage: true })
      await page.keyboard.press("Escape")
      await page.getByText("Use Blender from OpenCode.", { exact: true }).waitFor({ state: "hidden" })
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "About OpenCode for Blender")
      // State is text, with AA contrast over its tint.
      const ratio = await label(page, "blender").evaluate(element => {
        const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number)
        const blend = (top: number[], bottom: number[]) => { const alpha = top[3] ?? 1; return [0, 1, 2].map(index => top[index]! * alpha + bottom[index]! * (1 - alpha)) }
        const luminance = (rgb: number[]) => { const [r, g, b] = rgb.map(value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! }
        const base = parse(getComputedStyle(element.closest(".right-panel-accordion-item")!).backgroundColor)
        const background = blend(parse(getComputedStyle(element).backgroundColor), base)
        const color = parse(getComputedStyle(element).color)
        const [light, darker] = [luminance(color), luminance(background)].sort((a, b) => b - a)
        return (light! + 0.05) / (darker! + 0.05)
      })
      assert.ok(ratio >= 4.5, `state label contrast ${ratio.toFixed(2)} in ${dark ? "dark" : "light"}`)
      assert.equal(await label(page, "blender").evaluate(element => getComputedStyle(element).borderTopLeftRadius !== "0px"), true, "state labels use the chip radius")
      assert.equal(await body(page, "blender").locator(".integration-section-line").first().evaluate(element => getComputedStyle(element).borderTopLeftRadius), "0px")
      if (screenshots) await page.screenshot({ path: join(screenshots, `section-attached-${dark ? "dark" : "light"}.png`), clip: { x: 0, y: 600, width: 420, height: 400 } })
      // The section disappears while focus is inside: focus moves to the Plugins trigger.
      await action(page, "blender").focus()
      model.integrations.splice(0, 1)
      await notify(page)
      await trigger(page, "blender").waitFor({ state: "detached" })
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-status-section-trigger") === "plugins")
      await page.waitForFunction(() => document.querySelector("[data-integration-announcements]")?.textContent?.includes("removed from Status"))
      assert.equal(await page.locator('[aria-live="polite"][data-integration-announcements]').count(), 1, "one polite region per Status tab")
    } finally { await page.close() }
  }
})

test("AC-E7 the Plugins row of an integration offers only Update, Remove and Refresh; no attachment indicator outside its section", async () => {
  const { page } = await open(routes => { routes.model.bindings["first:blender"] = { state: "attached", label: "scene.blend" } })
  try {
    await waitLabel(page, "blender", "Attached")
    await page.locator('[data-plugin-id="neuralnomads.blender"]').getByRole("button", { name: "Actions for neuralnomads.blender", exact: true }).click()
    assert.deepEqual((await page.getByRole("menuitem").allInnerTexts()).map(item => item.trim()),
      ["Check updates for @neuralnomads/opencode-blender@^0.1", "Remove from Global", "Refresh plugin controls"])
    await page.keyboard.press("Escape")
    const outside = await page.evaluate(() => [...document.querySelectorAll("body *")]
      // The Status tab's polite region announces changes; it is no visible indicator.
      .filter(element => !element.closest("[data-status-section^='integration:'], [data-integration-announcements]") && element.children.length === 0)
      .map(element => element.textContent ?? "").filter(text => /Attached|scene\.blend|Detach/.test(text)))
    assert.deepEqual(outside, [])
    assert.equal(await page.locator("[data-integration-binding]").count(), 0)
  } finally { await page.close() }
})

test("integration sections render in French and right-to-left Hebrew with their translated labels", async () => {
  for (const locale of ["fr", "he"] as const) {
    const { page, errors } = await open(undefined, { locale })
    try {
      await trigger(page, "blender").waitFor()
      if (locale === "fr") await waitLabel(page, "blender", "Application disponible")
      await expand(page, "blender")
      await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-action]'))
      const attach = await action(page, "blender").innerText()
      if (locale === "fr") assert.equal(attach, "Attacher…")
      else assert.notEqual(attach, "Attach…")
      assert.equal(/Application available|No open application/.test(await body(page, "blender").innerText()), false, `${locale}: no English fallback`)
      if (screenshots) await page.screenshot({ path: join(screenshots, `section-${locale}.png`), clip: { x: 0, y: 600, width: 420, height: 400 } })
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("AC-E3 removing an earlier catalogue entry preserves the remaining section's focused DOM", async () => {
  const { page, model } = await open()
  try {
    await expand(page, "gaffer")
    const button = action(page, "gaffer")
    await button.focus()
    const original = await button.elementHandle()
    model.integrations.splice(0, 1)
    await notify(page)
    await trigger(page, "blender").waitFor({ state: "detached" })
    assert.equal(await original!.evaluate(element => element.isConnected && element === document.activeElement), true)
    assert.equal(await button.evaluate(element => element === document.activeElement), true)
  } finally { await page.close() }
})

test("AC-E3 focus remains visible when a focused integration disappears and Plugins is hidden", async () => {
  const { page, model, count } = await open()
  try {
    await expand(page, "blender")
    await page.getByRole("button", { name: "Customize right panel", exact: true }).click()
    await page.getByRole("group", { name: "Customize right panel", exact: true }).getByRole("checkbox", { name: "Plugins", exact: true }).uncheck()
    await page.keyboard.press("Escape")
    await action(page, "blender").focus()
    model.integrations.splice(0, 1)
    await notify(page)
    await trigger(page, "blender").waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-status-section-trigger"))
    assert.equal(count("detach") + count("attach") + count("remove"), 0)
  } finally { await page.close() }
})

test("AC-E6 a user collapse holds through passive refreshes; a different expected action expands once", async () => {
  const { page, model } = await open(routes => {
    routes.model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "absent", action: "install" }, connection: { offers: 0 } } })
  })
  try {
    await body(page, "blender").waitFor()
    await collapse(page, "blender")
    await notify(page)
    assert.equal(await trigger(page, "blender").getAttribute("aria-expanded"), "false")
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "outdated", action: "update" }, connection: { offers: 0 } } })
    await notify(page)
    await body(page, "blender").waitFor()
    await collapse(page, "blender")
    await notify(page)
    assert.equal(await trigger(page, "blender").getAttribute("aria-expanded"), "false")
    model.integrations[0] = integrationView("blender")
    model.bindings["first:blender"] = { state: "attached", label: "scene.blend" }
    await notify(page)
    await waitLabel(page, "blender", "Attached")
    await body(page, "blender").waitFor()
    await collapse(page, "blender")
    await notify(page)
    await waitLabel(page, "blender", "Attached")
    assert.equal(await trigger(page, "blender").getAttribute("aria-expanded"), "false", "authority reconciliation preserves the user's collapse")
  } finally { await page.close() }
})

test("AC-C3 Q8 hints are bounded display data and only matching fresh picker offers suggest reattachment", async () => {
  const { page, count } = await open()
  try {
    await expand(page, "blender")
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-state="available"]'))
    for (const hint of ["C:\\private\\scene.blend", "~secret", "x".repeat(121), "Other scene"]) {
      await fx(page, "hint", "blender", hint)
      assert.equal(await action(page, "blender").innerText(), "Attach…", "a hint alone cannot identify an offered application")
      await action(page, "blender").click()
      const picker = page.locator(".integration-attachment")
      await picker.getByRole("button", { name: "Attach", exact: true }).waitFor()
      assert.equal(await picker.getByRole("button", { name: "Reattach", exact: true }).count(), 0)
      assert.equal((await picker.innerText()).includes(hint), false)
      await picker.getByRole("button", { name: "Cancel", exact: true }).click()
    }
    await fx(page, "hint", "blender", "Scene")
    await action(page, "blender").click()
    await page.locator(".integration-attachment").getByRole("button", { name: "Reattach", exact: true }).waitFor()
    await page.locator(".integration-attachment").getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(await action(page, "blender").innerText(), "Reattach “Scene”", "the section can suggest reattachment after its explicit fresh matching offer read")
    await fx(page, "select", "second")
    await fx(page, "select", "first")
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-action]')?.textContent === "Attach…")
    await action(page, "blender").click()
    await page.locator(".integration-attachment").getByRole("button", { name: "Reattach", exact: true }).waitFor()
    await page.locator(".integration-attachment").getByRole("button", { name: "Cancel", exact: true }).click()
    await fx(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    await page.waitForFunction(() => document.querySelector('[data-integration-section="blender"] [data-conversation-action]')?.textContent === "Attach…")
    assert.equal(count("attach"), 0)
  } finally { await page.close() }
})

test("AC-C5 catalogue consent is revoked by navigation, native invalidation and reconnect before dispatch", async () => {
  const { page, count } = await open(routes => {
    routes.model.integrations.push(integrationView("resolve", { family: "api", plugin: { declared: false }, configured: false, configuredSources: [], state: "absent", status: undefined }))
  })
  try {
    await trigger(page, "blender").waitFor()
    for (const change of ["navigation", "event", "reconnect"]) {
      await page.mouse.move(0, 0)
      await page.getByRole("button", { name: "Add", exact: true }).click()
      await page.getByRole("menuitem", { name: "Add an integration…", exact: true }).click()
      const catalog = page.getByRole("dialog", { name: "Add an integration", exact: true })
      await catalog.getByRole("button", { name: "Install — OpenCode for Resolve", exact: true }).click()
      const consent = confirmation(page, /^Install integration/)
      await consent.waitFor()
      if (change === "navigation") await fx(page, "select", "second")
      else if (change === "event") await fx(page, "event", "plugin.updated")
      else await fx(page, "reconnect")
      await consent.waitFor({ state: "hidden" })
      assert.equal(count("install"), 0, `${change}: no installation`)
      if (await catalog.isVisible()) await catalog.getByRole("button", { name: "Close", exact: true }).click()
    }
  } finally { await page.close() }
})
