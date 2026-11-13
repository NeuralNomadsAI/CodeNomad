import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { integrationView, routeIntegrations, waitFor } from "./integration-plugin-row-model"

let browser: Browser, url: string
const screenshots = process.env.CODENOMAD_INTEGRATION_SCREENSHOTS
before(async () => {
  const fixture = await borrowFixture({ name: "integration-plugin-row", routes: [{ path: "/integration-row", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/integration-plugin-row.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  if (screenshots) mkdirSync(screenshots, { recursive: true })
})
after(async () => { await browser?.close() })

type Routes = Awaited<ReturnType<typeof routeIntegrations>>
const fx = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(([name, values]) => (window as any).integrationRow[name as string](...(values as unknown[])), [method, args] as const)

async function open(prepare?: (routes: Routes) => void, options: { dark?: boolean; locale?: string; clock?: boolean; captureChoice?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, colorScheme: options.dark ? "dark" : "light" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => { if (!localStorage.getItem("opencode-session-right-panel-tab-v2")) localStorage.setItem("opencode-session-right-panel-tab-v2", "status") })
  // Native events are dispatched explicitly; tsx names page functions with a page-absent `__name`.
  await page.addInitScript("window.__name = f => f")
  await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
  if (options.captureChoice) {
    // Retain the real menu callback, without its DOM lifetime, to exercise late delivery after navigation.
    await page.addInitScript(() => {
      ;(window as any).integrationChoices = []
      ;(window as any).captureIntegrationChoice = (callback: () => void) => {
        ;(window as any).integrationChoices.push(callback)
        return callback
      }
    })
    await page.route("**/src/components/integration-row-indicators.tsx", async route => {
      const response = await route.fetch(), source = await response.text()
      const handler = /onSelect: (\(\) => void (?:props\.binding\.attach\(offer\.offerID\)|offer\.attach\(\)))/
      assert.match(source, handler, "capture the production choice callback")
      await route.fulfill({ response, body: source.replace(handler, "onSelect: window.captureIntegrationChoice($1)") })
    })
  }
  if (options.clock) await page.clock.install()
  const routes = await routeIntegrations(page)
  readCounts.set(page, () => routes.count("read") + routes.count("binding"))
  prepare?.(routes)
  await page.goto(`${url}${options.locale ? `?locale=${options.locale}` : ""}`)
  await page.waitForFunction(() => Boolean((window as any).integrationRow), undefined, { timeout: 30_000 })
  return { page, errors, ...routes }
}

const row = (page: Page, id = "blender") => page.locator(`[data-plugin-id="neuralnomads.${id}"]`)
const link = (page: Page, id = "blender") => row(page, id).locator("[data-integration-link]")
const readCounts = new WeakMap<Page, () => number>()
/** The routes changed: OpenCode's payload-free event makes the row read again (coalesced over 300 ms). */
async function notify(page: Page, type = "rpc.neuralnomads.blender.status_changed") {
  const reads = readCounts.get(page)!, before = reads()
  await fx(page, "event", type)
  await waitFor(() => reads() > before, "the coalesced re-read", 10_000)
  await page.waitForTimeout(150)
}
const waitLink = (page: Page, state: string, label: string) => page.waitForFunction(([expectedState, expectedLabel]) => {
  const element = document.querySelector('[data-plugin-id="neuralnomads.blender"] [data-integration-link]')
  return element?.getAttribute("data-integration-link") === expectedState && (element.getAttribute("aria-label") ?? "").startsWith(`${expectedLabel} — `)
}, [state, label] as const)
async function openMenu(page: Page, name = "OpenCode for Blender") {
  await page.mouse.move(0, 0)
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click()
  await page.getByRole("menu").waitFor()
  return page.getByRole("menu")
}
const menuItems = async (page: Page) => (await page.getByRole("menuitem").allInnerTexts()).map(item => item.trim())
const confirmation = (page: Page, title: RegExp) => page.locator(".alert-dialog").filter({ has: page.locator("h2", { hasText: title }) })
const trackColor = (page: Page, id: string) => row(page, id).locator('[data-scope="global"] .MuiSwitch-track').evaluate(element => getComputedStyle(element).backgroundColor)
const resolved = (page: Page, property: string) => page.evaluate(name => {
  const probe = document.createElement("span")
  probe.style.color = `var(${name})`
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}, property)

test("one Plugins row per integration: display name, version and accent switches; no Status section of its own", async () => {
  const { page, errors } = await open()
  try {
    await row(page).locator(".plugin-control-name").getByText("OpenCode for Blender", { exact: true }).waitFor()
    assert.equal(await row(page).locator(".plugin-control-version").innerText(), "0.1.0")
    assert.equal(await row(page, "gaffer").locator(".plugin-control-name").innerText(), "OpenCode for Gaffer")
    assert.equal(await page.locator('[data-plugin-id="other.plugin"] .plugin-control-name').innerText(), "other.plugin")
    assert.equal(await page.locator('[data-plugin-id="other.plugin"] [data-integration-link]').count(), 0, "a plain plugin has no link")
    assert.equal(await page.locator('[data-status-section^="integration:"]').count(), 0)
    assert.equal(await page.getByText("Attach…").count(), 0)
    assert.equal(await row(page).getAttribute("data-integration"), "blender")
    await row(page).getByRole("checkbox", { name: "Change activation rule for OpenCode for Blender — Global" }).waitFor()

    // The default accent switch, exactly like Yolo; only plain plugin and MCP rows use the green variant.
    const accent = await resolved(page, "--session-yolo-accent")
    assert.equal(accent, await resolved(page, "--accent-primary"))
    // The track animates its colour: wait for it to settle.
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('[data-plugin-id="neuralnomads.blender"] [data-scope="global"] .MuiSwitch-track')!).backgroundColor === expected, accent)
      .catch(async () => assert.equal(await trackColor(page, "blender"), accent, "an integration's checked switch is the Yolo accent"))
    assert.notEqual(await page.locator('[data-plugin-id="other.plugin"] [data-scope="global"] .MuiSwitch-track').evaluate(element => getComputedStyle(element).backgroundColor), accent)
    // The real Yolo switch, turned on, has exactly the same colour.
    await page.locator(".yolo-mode-switch input").click()
    await page.waitForFunction(expected => getComputedStyle(document.querySelector(".yolo-mode-switch .MuiSwitch-track")!).backgroundColor === expected, accent)
    assert.equal(await page.locator(".yolo-mode-switch .MuiSwitch-thumb").evaluate(element => getComputedStyle(element).backgroundColor),
      await row(page).locator('[data-scope="global"] .MuiSwitch-thumb').evaluate(element => getComputedStyle(element).backgroundColor))
    if (screenshots) await page.screenshot({ path: join(screenshots, "integration-plugins-yolo.png"), fullPage: true })
    // The Project switch of a native integration is locked to Global and stays focusable.
    assert.equal(await row(page).locator('[data-scope="project"]').getAttribute("title"), "Global only")

    // "Integration" instead of "Plugin" in the row's tooltip, opened from the keyboard.
    await row(page).locator(".plugin-control-name").focus()
    await page.locator(".plugin-control-tooltip").first().waitFor()
    assert.match(await page.locator(".plugin-control-tooltip").first().innerText(), /^⁨?Integration: neuralnomads\.blender⁩?\n/)
    await page.locator('[data-plugin-id="other.plugin"] .plugin-control-name').focus()
    await page.waitForFunction(() => /^⁨?Plugin: other\.plugin/.test(document.querySelector(".plugin-control-tooltip")?.textContent ?? ""))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the chain button follows the displayed conversation's attachment, refreshed by hosts_changed and status_changed", async () => {
  for (const dark of [false, true]) {
    const { page, model, errors } = await open(undefined, { dark })
    try {
      await waitLink(page, "none", "No conversation attached")
      // A tooltip that opens from the keyboard.
      await link(page).focus()
      await page.locator(".plugin-control-tooltip").getByText("No conversation attached", { exact: true }).waitFor()

      // The integration attached the conversation itself at its first use: its event reads the binding again.
      model.bindings["first:blender"] = { state: "attached", label: "western_ia.blend" }
      await notify(page, "rpc.neuralnomads.blender.hosts_changed")
      await waitLink(page, "attached", "Attached to: western_ia.blend")
      // Attached reads as a pressed button: the shared icon-toggle active state.
      assert.equal(await link(page).getAttribute("aria-pressed"), "true")
      assert.notEqual(await link(page).evaluate(element => getComputedStyle(element).backgroundColor),
        await row(page).getByRole("button", { name: "Actions for OpenCode for Blender" }).evaluate(element => getComputedStyle(element).backgroundColor))
      if (screenshots) {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.mouse.move(0, 0)
        await page.locator(".plugin-control-tooltip").waitFor({ state: "hidden" })
        await page.locator(".plugin-controls").screenshot({ path: join(screenshots, `integration-plugins-${dark ? "dark" : "light"}.png`) })
      }

      // Another conversation is not attached; returning shows the attachment again.
      await fx(page, "select", "second")
      await waitLink(page, "none", "No conversation attached")
      await fx(page, "select", "first")
      await waitLink(page, "attached", "Attached to: western_ia.blend")

      // An integration that cannot tell stays unknown.
      model.bindings["first:blender"] = { state: "unknown" }
      await notify(page)
      await waitLink(page, "unknown", "Attachment unknown")

      // Other families and unloaded integrations have no chain.
      model.integrations[1] = integrationView("gaffer", { family: "vendor-mcp", status: { version: "1.0.0", connection: { state: "connected" } } })
      model.integrations[0] = integrationView("blender", { state: "inactive", status: undefined })
      await notify(page)
      await page.waitForFunction(() => !document.querySelector("[data-integration-link]"))
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("every row shows its version right after its name, before the row's buttons", async () => {
  const { page } = await open(routes => { routes.model.bindings["first:blender"] = { state: "attached", label: "Scene" } })
  try {
    await waitLink(page, "attached", "Attached to: Scene")
    for (const id of ["neuralnomads.blender", "other.plugin"]) {
      const box = (selector: string) => page.locator(`[data-plugin-id="${id}"] ${selector}`).first().boundingBox()
      const name = (await box(".plugin-control-name"))!, version = (await box(".plugin-control-version"))!
      const actions = (await box(".plugin-control-identity > button:not(.plugin-control-link)"))!
      assert.ok(version.x - (name.x + name.width) < 12, `${id}: the version follows the name`)
      assert.ok(version.x + version.width < actions.x - 4, `${id}: the buttons stay at the end of the row`)
    }
    // The chain button has the row's framed square button look.
    const chain = (await link(page).boundingBox())!, actions = (await row(page).locator(".plugin-control-identity > button:not(.plugin-control-link)").boundingBox())!
    assert.deepEqual([Math.round(chain.width), Math.round(chain.height)], [Math.round(actions.width), Math.round(actions.height)])
    assert.equal(await link(page).evaluate(element => getComputedStyle(element).borderTopWidth), "1px")
  } finally { await page.close() }
})

test("the chain button: attach to the only open document, detach, or explain why it cannot", async () => {
  const { page, model, calls, count } = await open()
  try {
    await waitLink(page, "none", "No conversation attached")
    assert.equal(await link(page).getAttribute("aria-pressed"), "false")
    assert.equal(await link(page).getAttribute("aria-label"), "No conversation attached — Attach the conversation")
    // One open document: one click attaches it directly, without a menu or confirmation.
    await link(page).click()
    await waitLink(page, "attached", "Attached to: Scene")
    assert.equal(count("hosts"), 1)
    assert.deepEqual(calls.find(call => call.action === "attach")!.body, { sessionID: "first", offerID: "offer-0001" })
    assert.equal(await page.locator("[data-integration-offers]").count(), 0)
    assert.equal(await link(page).getAttribute("aria-pressed"), "true")
    // Attached: one click detaches, like the row menu.
    await link(page).click()
    await waitFor(() => count("detach") === 1, "one detach")
    await waitLink(page, "none", "No conversation attached")

    // No open document: the button is unavailable and says why; a click reads nothing.
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 0 } } })
    await notify(page)
    await page.waitForFunction(() => document.querySelector('[data-integration-link]')?.getAttribute("aria-disabled") === "true")
    assert.equal(await link(page).getAttribute("aria-label"), "No conversation attached — Blender: no open document")
    await link(page).focus()
    await page.locator(".plugin-control-tooltip").getByText("Blender: no open document").waitFor()
    await link(page).click({ force: true })
    await page.waitForTimeout(300)
    assert.equal(count("hosts"), 1)
    // No conversation displayed: also unavailable.
    model.integrations[0] = integrationView("blender")
    await notify(page)
    await fx(page, "select", null)
    await page.waitForFunction(() => /No conversation displayed$/.test(document.querySelector('[data-integration-link]')?.getAttribute("aria-label") ?? ""))
    assert.equal(await link(page).getAttribute("aria-disabled"), "true")

    // A refused attachment is reported; the request is not repeated.
    await fx(page, "select", "first")
    await waitLink(page, "none", "No conversation attached")
    model.outcomes.attach = "busy"
    await link(page).click()
    await page.waitForFunction(() => JSON.stringify((window as any).integrationRow.toasts()).includes("This conversation is already attached to another document."))
    assert.equal(count("attach"), 2)
  } finally { await page.close() }
})

test("the chain button offers the choice between several open documents", async () => {
  const { page, model, calls, count } = await open(routes => {
    routes.model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 2 } } })
    routes.model.offers = [
      { offerID: "offer-0001", label: "Blender: western_ia.blend", document: "western_ia.blend", appVersion: "5.3", protocol: "ok" },
      { offerID: "offer-0002", label: "Blender: teaser.blend", document: "teaser.blend", appVersion: "5.3", protocol: "ok" },
      { offerID: "offer-0003", label: "Blender: old.blend", document: "old.blend", appVersion: "4.0", protocol: "incompatible" },
    ]
  })
  try {
    await waitLink(page, "none", "No conversation attached")
    await link(page).focus()
    await page.keyboard.press("Enter")
    const menu = page.locator("[data-integration-offers]")
    await menu.waitFor()
    assert.equal((await menu.locator(".action-overflow-info").innerText()).trim(), "Attach to which document?")
    assert.deepEqual((await menu.getByRole("menuitem").allInnerTexts()).map(item => item.trim()), ["Blender: western_ia.blend", "Blender: teaser.blend"],
      "only compatible documents are offered")
    assert.equal(count("attach"), 0, "opening the choice attaches nothing")
    await menu.getByRole("menuitem", { name: "Blender: teaser.blend" }).click()
    await waitLink(page, "attached", "Attached to: Blender: teaser.blend")
    assert.deepEqual(calls.find(call => call.action === "attach")!.body, { sessionID: "first", offerID: "offer-0002" })
    // Escape closes the choice without attaching.
    model.bindings["first:blender"] = { state: "none" }
    await notify(page, "rpc.neuralnomads.blender.hosts_changed")
    await waitLink(page, "none", "No conversation attached")
    await link(page).click()
    await menu.waitFor()
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "hidden" })
    assert.equal(count("attach"), 1)
  } finally { await page.close() }
})

const intentChanges = ["plugin.updated", "config.updated", "rpc.neuralnomads.blender.hosts_changed",
  "rpc.neuralnomads.blender.status_changed", "reconnect", "session-aba", "inactive", "disposed"] as const
type IntentChange = typeof intentChanges[number]
async function revokeAttachIntent(page: Page, change: IntentChange) {
  if (change === "session-aba") {
    await fx(page, "select", "second")
    await waitLink(page, "none", "No conversation attached")
    await fx(page, "select", "first")
  } else if (change === "inactive") await fx(page, "active", false)
  else if (change === "disposed") {
    await fx(page, "plugins", await page.evaluate(() => {
      const snapshot = (window as any).integrationRow.base()
      snapshot.controls = snapshot.controls.filter((entry: any) => entry.id !== "neuralnomads.blender")
      snapshot.runtime = snapshot.runtime.filter((entry: any) => entry.id !== "neuralnomads.blender")
      snapshot.configured.sources = snapshot.configured.sources.filter((entry: any) => entry.pluginId !== "neuralnomads.blender")
      return snapshot
    }), false)
    await page.locator("[data-plugin-refresh]").click()
  }
  else if (change === "reconnect") await fx(page, "reconnect")
  else await fx(page, "event", change)
  if (change === "inactive" || change === "disposed") await row(page).waitFor({ state: "detached" })
}

for (const change of intentChanges) test(`attach intent: ${change} revokes held hosts without submitting or showing an error`, async () => {
  const { page, model, count } = await open(routes => { routes.model.hold.add("hosts") })
  try {
    await waitLink(page, "none", "No conversation attached")
    await link(page).click()
    await waitFor(() => model.held.some(call => call.action === "hosts"), "the held hosts read")
    const read = model.held.find(call => call.action === "hosts")!
    const aborted = page.waitForEvent("requestfailed", { predicate: request => request.url() === read.route.request().url()
      && request.failure()?.errorText === "net::ERR_ABORTED", timeout: 2_000 }).then(() => true, () => false)
    await revokeAttachIntent(page, change)
    await read.route.fulfill({ json: { offers: model.offers } })
    const cancelled = await aborted
    if (change !== "inactive" && change !== "disposed") {
      await page.waitForFunction(() => document.querySelector('[data-plugin-id="neuralnomads.blender"] [data-integration-link]')?.getAttribute("aria-busy") === "false")
    }
    assert.equal(count("attach"), 0)
    assert.equal(cancelled, true, "revocation aborts its own enumeration read")
    assert.equal(count("hosts"), 1, "revocation never replays enumeration")
    assert.equal(await page.locator("[data-integration-offers]").count(), 0)
    assert.equal(await page.evaluate(() => JSON.stringify((window as any).integrationRow.toasts()).includes("Not confirmed.")), false)
  } finally { await page.close() }
})

for (const change of ["plugin.updated", "rpc.neuralnomads.blender.hosts_changed", "reconnect", "session-aba"] as const)
  test(`attach intent: ${change} closes an open document choice`, async () => {
    const { page, count } = await open(routes => {
      routes.model.offers.push({ offerID: "offer-0002", label: "second document", protocol: "ok" })
    })
    try {
      await waitLink(page, "none", "No conversation attached")
      await link(page).click()
      const menu = page.locator("[data-integration-offers]")
      await menu.waitFor()
      await revokeAttachIntent(page, change)
      await menu.waitFor({ state: "hidden", timeout: 2_000 })
      assert.equal(count("attach"), 0)
    } finally { await page.close() }
  })

test("attach intent: a retained document callback cannot attach a newly displayed conversation", async () => {
  const { page, calls, count } = await open(routes => {
    routes.model.offers.push({ offerID: "offer-0002", label: "second document", protocol: "ok" })
  }, { captureChoice: true })
  try {
    await waitLink(page, "none", "No conversation attached")
    await link(page).click()
    await page.locator("[data-integration-offers]").waitFor()
    await fx(page, "select", "second")
    await waitLink(page, "none", "No conversation attached")
    await link(page).click()
    const menu = page.locator("[data-integration-offers]")
    await menu.waitFor()
    await page.evaluate(() => (window as any).integrationChoices[0]())
    await page.waitForTimeout(150)
    assert.equal(count("attach"), 0, "selection retains the original gesture, target and offer")
    assert.equal(await menu.isVisible(), true, "the stale selection leaves the new intent intact")
    await menu.getByRole("menuitem", { name: "second document", exact: true }).click()
    await waitFor(() => count("attach") === 1, "the current choice still works")
    assert.deepEqual(calls.find(call => call.action === "attach")!.body, { sessionID: "second", offerID: "offer-0002" })
  } finally { await page.close() }
})

test("attach intent: an old hosts finally cannot clear the next conversation's busy state", async () => {
  const { page, model, calls, count } = await open(routes => { routes.model.hold.add("hosts") })
  try {
    await waitLink(page, "none", "No conversation attached")
    await link(page).click()
    await waitFor(() => model.held.length === 1, "first hosts")
    await fx(page, "select", "second")
    await waitLink(page, "none", "No conversation attached")
    await link(page).click()
    await waitFor(() => model.held.length === 2, "second hosts")
    await model.held[0]!.route.fulfill({ json: { offers: model.offers } })
    assert.equal(await link(page).getAttribute("aria-busy"), "true")
    assert.equal(count("attach"), 0)
    await model.held[1]!.route.fulfill({ json: { offers: model.offers } })
    await waitLink(page, "attached", "Attached to: Scene")
    assert.deepEqual(calls.find(call => call.action === "attach")!.body, { sessionID: "second", offerID: "offer-0001" })
  } finally { await page.close() }
})

test("attach intent: an admitted uncertain mutation survives invalidation and navigation without replay", async () => {
  const { page, model, calls, count } = await open(routes => {
    routes.model.hold.add("hosts")
    routes.model.hold.add("attach")
  })
  try {
    await waitLink(page, "none", "No conversation attached")
    await link(page).focus()
    await page.keyboard.press("Space")
    await waitFor(() => count("hosts") === 1, "one enumeration")
    await link(page).click({ force: true })
    await page.keyboard.press("Enter")
    assert.equal(count("hosts"), 1)
    await model.held.find(call => call.action === "hosts")!.route.fulfill({ json: { offers: model.offers } })
    await waitFor(() => model.held.some(call => call.action === "attach"), "the admitted attach")
    const mutation = model.held.find(call => call.action === "attach")!
    await fx(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    await fx(page, "select", "second")
    await waitLink(page, "none", "No conversation attached")
    assert.equal(mutation.route.request().failure(), null, "revocation leaves the admitted mutation alone")
    model.bindings["first:blender"] = { state: "attached", label: "Scene" }
    await mutation.route.abort("connectionfailed")
    await fx(page, "select", "first")
    await waitLink(page, "attached", "Attached to: Scene")
    assert.equal(count("attach"), 1)
    assert.equal(count("detach"), 0)
    assert.deepEqual(calls.find(call => call.action === "attach")!.body, { sessionID: "first", offerID: "offer-0001" })
  } finally { await page.close() }
})

test("an indicator appears only when the application part needs an action", async () => {
  const { page, model } = await open()
  try {
    await waitLink(page, "none", "No conversation attached")
    assert.equal(await page.locator("[data-integration-attention]").count(), 0)
    for (const [state, label] of [["absent", "Blender part missing"], ["outdated", "Blender part needs an update"], ["incompatible", "Incompatible with this Blender"]] as const) {
      model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state, ...(state === "incompatible" ? {} : { action: state === "absent" ? "install" : "update" }) }, connection: { offers: 0 } } })
      await notify(page)
      await page.waitForFunction(expected => document.querySelector('[data-plugin-id="neuralnomads.blender"] [data-integration-attention]')?.getAttribute("aria-label") === expected, label)
    }
    for (const state of ["unknown", "ok"] as const) {
      model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state }, connection: { offers: 0 } } })
      await notify(page)
      await page.waitForFunction(() => !document.querySelector("[data-integration-attention]"))
    }
  } finally { await page.close() }
})

test("the row menu: connection state, application part installation, Detach the conversation and removal", async () => {
  const { page, model, calls, count } = await open(routes => {
    routes.model.bindings["first:blender"] = { state: "attached", label: "western_ia.blend" }
  }, { clock: true })
  try {
    await waitLink(page, "attached", "Attached to: western_ia.blend")
    let menu = await openMenu(page)
    assert.equal((await menu.locator("[data-integration-connection]").innerText()).trim(), "Blender: 1 open document")
    assert.deepEqual(await menuItems(page), ["Detach the conversation", "Check updates for @neuralnomads/opencode-blender@^0.1", "Remove from Global", "Refresh plugin controls"])

    // One click detaches the displayed conversation only, then reads its binding again.
    await page.getByRole("menuitem", { name: "Detach the conversation", exact: true }).click()
    await waitFor(() => count("detach") === 1, "one detachHost")
    assert.deepEqual(calls.find(call => call.action === "detach")!.body, { sessionID: "first" })
    await waitLink(page, "none", "No conversation attached")
    menu = await openMenu(page)
    assert.equal((await menuItems(page)).includes("Detach the conversation"), false)
    await page.keyboard.press("Escape")

    // The application part is missing: the menu installs it after the guarded confirmation.
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "absent", action: "install" }, connection: { offers: 0 } } })
    await notify(page)
    await row(page).locator("[data-integration-attention]").waitFor()
    menu = await openMenu(page)
    assert.equal((await menu.locator("[data-integration-connection]").innerText()).trim(), "Blender: no open document")
    assert.equal((await menuItems(page))[0], "Install in application…")
    await page.getByRole("menuitem", { name: "Install in application…", exact: true }).click()
    const dialog = confirmation(page, /^Install in application…/)
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /Install the Blender part of OpenCode for Blender 0\.1\.0 on the machine where OpenCode runs\?/)
    const confirm = dialog.getByRole("button", { name: "Install in application…", exact: true })
    assert.equal(await confirm.isDisabled(), true, "the action waits 600 ms")
    await page.clock.fastForward(650)
    await confirm.click()
    await waitFor(() => count("install-host") === 1, "one installHost")
    await page.waitForFunction(() => JSON.stringify((window as any).integrationRow.toasts()).includes("Application part installed."))

    // An outdated part offers Update; a closed application, none.
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "outdated", action: "update" }, connection: { offers: 2 } } })
    await notify(page)
    await openMenu(page)
    assert.equal((await menuItems(page))[0], "Update application…")
    assert.equal((await page.locator("[data-integration-connection]").innerText()).trim(), "Blender: 2 open documents")
    await page.keyboard.press("Escape")
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "unknown" }, connection: { offers: 0 } } })
    await notify(page)
    await openMenu(page)
    assert.equal((await page.locator("[data-integration-connection]").innerText()).trim(), "Blender closed")
    assert.deepEqual(await menuItems(page), ["Check updates for @neuralnomads/opencode-blender@^0.1", "Remove from Global", "Refresh plugin controls"])

    // Removal names the integration and keeps its guarded confirmation.
    await page.getByRole("menuitem", { name: "Remove from Global", exact: true }).click()
    const removal = confirmation(page, /^Remove from Global — /)
    await removal.waitFor()
    assert.match(await removal.locator("h2").innerText(), /OpenCode for Blender/)
    await removal.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(count("remove"), 0)
  } finally { await page.close() }
})

test("a lost detach answer is reported and read again, never replayed", async () => {
  const { page, model, count } = await open(routes => { routes.model.bindings["first:blender"] = { state: "attached", label: "scene.blend" } })
  try {
    await waitLink(page, "attached", "Attached to: scene.blend")
    model.fail.set("detach", "network")
    await openMenu(page)
    await page.getByRole("menuitem", { name: "Detach the conversation", exact: true }).click()
    await page.waitForFunction(() => JSON.stringify((window as any).integrationRow.toasts()).includes("Not confirmed. Check the application, then refresh."))
    await waitFor(() => count("binding") >= 2, "the binding is read again")
    await page.waitForTimeout(400)
    assert.equal(count("detach"), 1)
  } finally { await page.close() }
})

test("header and row Refresh recover unknown bindings without events, for the displayed conversation only", async () => {
  const { page, model, calls, count } = await open(routes => {
    routes.model.bindings["first:blender"] = { state: "unknown" }
    routes.model.bindings["second:blender"] = { state: "unknown" }
  })
  try {
    await waitLink(page, "unknown", "Attachment unknown")
    await waitFor(() => calls.filter(call => call.action === "binding" && call.sessionID === "first").length === 2,
      "the initial unknown binding answers")
    model.bindings["first:blender"] = { state: "attached", label: "first.blend" }
    await page.locator("[data-plugin-refresh]").click()
    await waitLink(page, "attached", "Attached to: first.blend")
    await fx(page, "select", "second")
    await waitLink(page, "unknown", "Attachment unknown")
    await waitFor(() => calls.filter(call => call.action === "binding" && call.sessionID === "second").length === 2,
      "the new conversation's unknown binding answers")
    const start = calls.length
    model.bindings["second:blender"] = { state: "attached", label: "second.blend" }
    await openMenu(page)
    await page.getByRole("menuitem", { name: "Refresh plugin controls", exact: true }).click()
    await waitLink(page, "attached", "Attached to: second.blend")
    const refreshed = calls.slice(start).filter(call => call.action === "binding")
    assert.deepEqual(refreshed.map(call => [call.sessionID, call.integration]).sort(),
      [["second", "blender"], ["second", "gaffer"]])
    assert.equal(count("detach"), 0)
  } finally { await page.close() }
})

test("an uncertain detach whose reread fails stays unknown until explicit Refresh, without replay", async () => {
  const { page, model, count } = await open(routes => {
    routes.model.bindings["first:blender"] = { state: "attached", label: "first.blend" }
    routes.model.hold.add("detach")
  })
  try {
    await waitLink(page, "attached", "Attached to: first.blend")
    const reads = count("binding")
    await openMenu(page)
    await page.getByRole("menuitem", { name: "Detach the conversation", exact: true }).click()
    await waitFor(() => model.held.some(call => call.action === "detach"), "the admitted detach")
    model.bindings["first:blender"] = { state: "none" }
    model.fail.set("binding", 503)
    await model.held.find(call => call.action === "detach")!.route.abort("connectionfailed")
    await waitFor(() => count("binding") > reads, "the failed authoritative reread")
    await waitLink(page, "unknown", "Attachment unknown")
    model.fail.delete("binding")
    await openMenu(page)
    await page.getByRole("menuitem", { name: "Refresh plugin controls", exact: true }).click()
    await waitLink(page, "none", "No conversation attached")
    assert.equal(count("detach"), 1)
  } finally { await page.close() }
})

for (const origin of ["other", "virtual", "runtime-only"] as const) test(`${origin} integrations retain native row actions without writable source authority`, async () => {
  const pluginId = "acme.render"
  const { page, model, calls, count } = await open(routes => {
    routes.model.integrations = [integrationView("blender", {
      configuredSources: [], configuredRules: [], scopes: [],
      plugin: { declared: origin !== "runtime-only", runtime: "loaded", runtimeId: pluginId },
      status: { version: "0.1.0", host: { state: "absent", action: "install" }, connection: { offers: 1 } },
    })]
    routes.model.bindings["first:blender"] = { state: "attached", label: "readonly.blend" }
  })
  try {
    await fx(page, "plugins", await page.evaluate(({ pluginId, origin }) => {
      const snapshot = (window as any).integrationRow.base()
      const control = snapshot.controls.find((control: any) => control.id === "neuralnomads.blender")
      control.id = control.runtime.id = pluginId
      const source = snapshot.configured.sources.find((source: any) => source.pluginId === "neuralnomads.blender")
      source.pluginId = pluginId
      source.scope = origin === "virtual" ? "virtual" : "other"
      source.path = origin === "virtual" ? undefined : "/ancestor/opencode.jsonc"
      if (origin === "runtime-only") snapshot.configured.sources = snapshot.configured.sources.filter((item: any) => item !== source)
      snapshot.targets = []
      return snapshot
    }, { pluginId, origin }))
    const integration = page.locator(`[data-plugin-id="${pluginId}"]`)
    await integration.locator('.plugin-control-name').getByText("OpenCode for Blender", { exact: true }).waitFor()
    await integration.locator('[data-integration-link="attached"]').waitFor()
    assert.equal(await page.locator('[data-integration="blender"]').count(), 1)
    assert.equal(await integration.getByRole("checkbox").count(), 2)
    for (const checkbox of await integration.getByRole("checkbox").all()) assert.equal(await checkbox.isDisabled(), true)
    await openMenu(page)
    assert.equal((await menuItems(page)).some(item => item.startsWith("Remove from")), false)
    await page.getByRole("menuitem", { name: /^Install in application/ }).click()
    const dialog = confirmation(page, /^Install in application/)
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /OpenCode for Blender 0\.1\.0/)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(count("install-host"), 0)
    await openMenu(page)
    await page.getByRole("menuitem", { name: "Detach the conversation", exact: true }).click()
    await integration.locator('[data-integration-link="none"]').waitFor()
    assert.deepEqual(calls.find(call => call.action === "detach")!.body, { sessionID: "first" })
    assert.equal(count("remove"), 0)
    assert.equal(model.integrations[0].plugin.runtimeId, pluginId)
  } finally { await page.close() }
})

test("ambiguous identities cannot claim a plain row, and inactive panels or unloaded integrations demand no bindings", async () => {
  const { page, model, count } = await open(routes => {
    routes.model.integrations[0] = integrationView("blender", { ambiguous: true, configuredSources: [],
      plugin: { declared: true, runtime: "loaded", runtimeId: "other.plugin" }, state: "non-conforming", status: undefined })
    routes.model.integrations[1] = integrationView("gaffer", { state: "inactive", status: undefined, plugin: { declared: true } })
  })
  try {
    await page.locator('[data-plugin-id="other.plugin"]').waitFor()
    await waitFor(() => count("read") > 0, "integration inventory")
    assert.equal(await page.locator('[data-plugin-id="other.plugin"]').getAttribute("data-integration"), null)
    assert.equal(count("binding"), 0)
    await fx(page, "active", false)
    const reads = count("read")
    model.integrations[0] = integrationView("blender")
    await fx(page, "event", "plugin.updated")
    await page.waitForTimeout(500)
    assert.equal(count("read"), reads)
    assert.equal(count("binding"), 0)
    await fx(page, "active", true)
    await waitLink(page, "none", "No conversation attached")
    assert.equal(count("binding"), 1, "only the loaded integration of the active panel")
  } finally { await page.close() }
})

test("two scoped declarations keep one integration row and exact scoped removal", async () => {
  const { page, calls, count } = await open(routes => {
    routes.model.integrations[0].configuredSources.push({ scope: "project", entryIndex: 4, expectedRevision: "b".repeat(64) })
  })
  try {
    await row(page).waitFor()
    await fx(page, "plugins", await page.evaluate(() => {
      const snapshot = (window as any).integrationRow.base()
      snapshot.configured.sources.push({ ...snapshot.configured.sources[1], scope: "project",
        path: "/repo/.opencode/opencode.jsonc", entryIndex: 4 })
      return snapshot
    }))
    await waitLink(page, "none", "No conversation attached")
    assert.equal(await page.locator('[data-integration="blender"]').count(), 1)
    await openMenu(page)
    assert.ok((await menuItems(page)).includes("Remove from Global"))
    await page.getByRole("menuitem", { name: "Remove from Project", exact: true }).click()
    const dialog = confirmation(page, /^Remove from Project/)
    await dialog.waitFor()
    await page.waitForTimeout(650)
    await dialog.getByRole("button", { name: "Remove from Project", exact: true }).click()
    await waitFor(() => count("remove") === 1, "one scoped removal")
    assert.deepEqual(calls.find(call => call.action === "remove")!.body, { location: { directory: "/repo" },
      scope: "project", target: "@neuralnomads/opencode-blender@^0.1", entryIndex: 4, expectedRevision: "b".repeat(64) })
    assert.equal(count("detach"), 0)
  } finally { await page.close() }
})

test("the row renders in French and right-to-left Hebrew with translated labels", async () => {
  for (const locale of ["fr", "he"] as const) {
    const { page, errors } = await open(routes => { routes.model.bindings["first:blender"] = { state: "attached", label: "western_ia.blend" } }, { locale })
    try {
      await page.waitForFunction(() => document.querySelector('[data-plugin-id="neuralnomads.blender"] [data-integration-link="attached"]'))
      const label = await link(page).getAttribute("aria-label")
      if (locale === "fr") assert.equal(label, "Rattachée à : western_ia.blend — Détacher la conversation")
      else assert.equal(label?.startsWith("Attached to:"), false)
      await page.mouse.move(0, 0)
      await row(page).locator(".plugin-control-identity > button:not(.plugin-control-link)").click()
      const items = await menuItems(page)
      if (locale === "fr") assert.equal(items[0], "Détacher la conversation")
      assert.equal(items.some(item => /Detach the conversation|Remove from/.test(item)), false, `${locale}: no English fallback`)
      await page.keyboard.press("Escape")
      // Closing the menu returns focus to its trigger first.
      await page.getByRole("menu").waitFor({ state: "hidden" })
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-haspopup") === "true")
      await row(page).locator(".plugin-control-name").focus()
      await page.locator(".plugin-control-tooltip").first().waitFor()
      if (locale === "fr") assert.match(await page.locator(".plugin-control-tooltip").first().innerText(), /^⁨?Intégration : neuralnomads\.blender/)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
})

test("the catalogue window installs by catalogue ID after confirmation and reports catalogue states", async () => {
  const { page, model, calls, count } = await open(routes => {
    routes.model.integrations.push(
      integrationView("resolve", { family: "vendor-mcp", plugin: { declared: false }, configured: false, configuredSources: [], state: "absent", status: undefined, version: undefined }),
      integrationView("houdini", { plugin: { declared: false }, configured: true, configuredSources: [], state: "inactive", status: undefined, version: undefined }),
    )
  })
  try {
    await row(page).waitFor()
    const openCatalog = async () => {
      await page.mouse.move(0, 0)
      await page.getByRole("button", { name: "Add", exact: true }).click()
      await page.getByRole("menuitem", { name: "Add an integration…", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Add an integration" })
      await dialog.waitFor()
      return dialog
    }
    let catalog = await openCatalog()
    assert.deepEqual(await catalog.locator("[data-catalog-integration]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-catalog-integration"))), ["resolve", "houdini"])
    const houdini = catalog.locator('[data-catalog-integration="houdini"]')
    assert.equal(await houdini.getByText("In the application", { exact: true }).count(), 1)
    assert.equal(await houdini.getByRole("combobox").getAttribute("title"), "Global only")
    const resolve = catalog.locator('[data-catalog-integration="resolve"]')
    await resolve.getByRole("combobox").selectOption("project")
    await resolve.getByRole("button", { name: "Install — OpenCode for Resolve", exact: true }).click()
    const consent = confirmation(page, /^Install integration/)
    await consent.waitFor()
    assert.match(await consent.innerText(), /Install OpenCode for Resolve \(Project\)\? The code will run with your rights in OpenCode\./)
    await page.waitForTimeout(650)
    await consent.getByRole("button", { name: "Install", exact: true }).click()
    await catalog.waitFor({ state: "hidden" })
    await waitFor(() => count("install") === 1, "one install by ID")
    assert.deepEqual(calls.find(call => call.action === "install")!, { action: "install", method: "POST", integration: "resolve", directory: "/repo", body: { scope: "project" } })

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
  } finally { await page.close() }
})

test("catalogue consent is revoked by navigation, native invalidation and reconnect before dispatch", async () => {
  const { page, count } = await open(routes => {
    routes.model.integrations.push(integrationView("resolve", { family: "api", plugin: { declared: false }, configured: false, configuredSources: [], state: "absent", status: undefined }))
  })
  try {
    await row(page).waitFor()
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
