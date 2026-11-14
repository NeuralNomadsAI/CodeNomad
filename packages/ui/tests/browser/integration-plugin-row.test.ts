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
    await page.route("**/src/components/integration-state-line.tsx", async route => {
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
/** The state line under an integration's name, and its action button or information text. */
const line = (page: Page, id = "blender") => row(page, id).locator(".plugin-control-state")
const link = (page: Page, id = "blender") => line(page, id).locator(".plugin-control-state-action, .plugin-control-state-info")
const readCounts = new WeakMap<Page, () => number>()
/** The routes changed: OpenCode's payload-free event makes the row read again (coalesced over 300 ms). */
async function notify(page: Page, type = "rpc.neuralnomads.blender.status_changed") {
  const reads = readCounts.get(page)!, before = reads()
  await fx(page, "event", type)
  await waitFor(() => reads() > before, "the coalesced re-read", 10_000)
  await page.waitForTimeout(150)
}
/** "attached" to a document (shown name), or "none": the line offers to attach. */
const waitLink = (page: Page, state: "attached" | "none", shown?: string) => page.waitForFunction(([expected, name]) => {
  const element = document.querySelector('[data-plugin-id="neuralnomads.blender"] .plugin-control-state')
  const key = element?.getAttribute("data-integration-state-line") ?? ""
  const title = element?.querySelector("[title]")?.getAttribute("title") ?? ""
  return expected === "attached" ? key === "attached" && (!name || title.startsWith(`${name}\n`)) : key === "attachOne" || key === "attachMany"
}, [state, shown] as const)
const waitLine = (page: Page, key: string, text: string) => page.waitForFunction(([expectedKey, expectedText]) => {
  const element = document.querySelector('[data-plugin-id="neuralnomads.blender"] .plugin-control-state')
  return element?.getAttribute("data-integration-state-line") === expectedKey && element.textContent === expectedText
}, [key, text] as const)
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
    assert.equal(await page.locator('[data-plugin-id="other.plugin"] .plugin-control-state').count(), 0, "a plain plugin has no state line")
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

    // "Integration" instead of "Plugin" in the name's native title; the row describes itself with the same details.
    assert.match(await row(page).locator(".plugin-control-name").getAttribute("title") ?? "", /^⁨?Integration: neuralnomads\.blender⁩?\n/)
    assert.match(await page.locator('[data-plugin-id="other.plugin"] .plugin-control-name').getAttribute("title") ?? "", /^⁨?Plugin: other\.plugin/)
    const described = await row(page).getAttribute("aria-describedby")
    assert.equal(await page.locator(`[id="${described}"]`).textContent(), await row(page).locator(".plugin-control-name").getAttribute("title"))
    assert.equal(await row(page).locator(".plugin-control-name").getAttribute("tabindex"), null, "no custom tooltip trigger in the rows")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the state line follows the displayed conversation's attachment, refreshed by hosts_changed and status_changed", async () => {
  const { page, model, errors } = await open()
  try {
    await waitLine(page, "attachOne", "Attach scene.blend")
    assert.equal(await link(page).getAttribute("title"), "Attach scene.blend")
    // The integration attached the conversation itself at its first use: its event reads the binding again.
    model.bindings["first:blender"] = { state: "attached", label: "Scene" }
    await notify(page, "rpc.neuralnomads.blender.hosts_changed")
    await waitLine(page, "attached", "scene.blend")
    assert.equal(await link(page).getAttribute("title"), "scene.blend\nDetach the conversation")
    assert.equal(await link(page).getAttribute("aria-label"), "scene.blend — Detach the conversation")
    assert.equal(await link(page).locator("svg").count(), 1, "a chain icon before the document")
    // Another conversation is not attached; returning shows the attachment again.
    await fx(page, "select", "second")
    await waitLink(page, "none")
    await fx(page, "select", "first")
    await waitLink(page, "attached", "scene.blend")
    // An integration that cannot tell offers to attach again.
    model.bindings["first:blender"] = { state: "unknown" }
    await notify(page)
    await waitLink(page, "none")
    // Other families and unloaded integrations: their own states, never an attach action.
    model.integrations[1] = integrationView("gaffer", { family: "vendor-mcp", status: { version: "1.0.0", connection: { state: "connected" } } })
    model.integrations[0] = integrationView("blender", { state: "inactive", status: undefined })
    await notify(page)
    await waitLine(page, "inactive", "Not loaded")
    await page.waitForFunction(() => document.querySelector('[data-plugin-id="neuralnomads.gaffer"] .plugin-control-state')?.textContent === "Server detected")
    assert.equal(await page.locator(".plugin-control-state-action").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("every row shows its version right after its name; an integration's state line sits under it", async () => {
  const { page } = await open(routes => { routes.model.bindings["first:blender"] = { state: "attached", label: "Scene" } })
  try {
    await waitLink(page, "attached", "scene.blend")
    for (const id of ["neuralnomads.blender", "other.plugin"]) {
      const box = (selector: string) => page.locator(`[data-plugin-id="${id}"] ${selector}`).first().boundingBox()
      const name = (await box(".plugin-control-name"))!, version = (await box(".plugin-control-version"))!
      const actions = (await box(".plugin-control-identity > button"))!
      assert.ok(version.x - (name.x + name.width) < 12, `${id}: the version follows the name`)
      assert.ok(version.x + version.width < actions.x - 4, `${id}: the buttons stay at the end of the row`)
    }
    const name = (await row(page).locator(".plugin-control-name").boundingBox())!, state = (await line(page).boundingBox())!
    assert.ok(state.y >= name.y + name.height - 1, "the state line is under the name")
    assert.ok(Math.abs(state.x - name.x) < 2, "aligned with the name")
  } finally { await page.close() }
})

test("the state line attaches the only open document, detaches, and only informs when nothing can be done", async () => {
  const { page, model, calls, count } = await open()
  try {
    await waitLine(page, "attachOne", "Attach scene.blend")
    const before = count("hosts")
    // One open document: one click attaches it directly, without a menu or confirmation.
    await link(page).click()
    await waitLine(page, "attached", "scene.blend")
    assert.equal(count("hosts"), before + 1, "the documents are read afresh before attaching")
    assert.deepEqual(calls.find(call => call.action === "attach")!.body, { sessionID: "first", offerID: "offer-0001" })
    assert.equal(await page.locator("[data-integration-offers]").count(), 0)
    // Attached: one click detaches.
    await link(page).click()
    await waitFor(() => count("detach") === 1, "one detach")
    await waitLine(page, "attachOne", "Attach scene.blend")

    // No open document: muted text, no button.
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 0 } } })
    await notify(page)
    await waitLine(page, "noOffer", "Blender: no open document")
    assert.equal(await line(page).locator("button").count(), 0)
    assert.equal(await line(page).getAttribute("data-tone"), "info")
    // No conversation displayed.
    model.integrations[0] = integrationView("blender")
    await notify(page)
    await fx(page, "select", null)
    await waitLine(page, "noConversation", "No conversation displayed")

    // A refused attachment is reported; the request is not repeated.
    await fx(page, "select", "first")
    await waitLine(page, "attachOne", "Attach scene.blend")
    model.outcomes.attach = "busy"
    await link(page).click()
    await page.waitForFunction(() => JSON.stringify((window as any).integrationRow.toasts()).includes("This conversation is already attached to another document."))
    assert.equal(count("attach"), 2)
  } finally { await page.close() }
})

test("the state line offers the choice between several open documents", async () => {
  const { page, model, calls, count } = await open(routes => {
    routes.model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 2 } } })
    routes.model.offers = [
      { offerID: "offer-0001", label: "Blender: western_ia.blend", document: "western_ia.blend", appVersion: "5.3", protocol: "ok" },
      { offerID: "offer-0002", label: "Blender: teaser.blend", document: "teaser.blend", appVersion: "5.3", protocol: "ok" },
      { offerID: "offer-0003", label: "Blender: old.blend", document: "old.blend", appVersion: "4.0", protocol: "incompatible" },
    ]
  })
  try {
    await waitLine(page, "attachMany", "Attach…")
    await link(page).focus()
    await page.keyboard.press("Enter")
    const menu = page.locator("[data-integration-offers]")
    await menu.waitFor()
    assert.equal((await menu.locator(".action-overflow-info").innerText()).trim(), "Attach to which document?")
    assert.deepEqual((await menu.getByRole("menuitem").allInnerTexts()).map(item => item.trim()), ["western_ia.blend", "teaser.blend"],
      "only compatible documents are offered")
    assert.equal(count("attach"), 0, "opening the choice attaches nothing")
    await menu.getByRole("menuitem", { name: "teaser.blend" }).click()
    await waitLine(page, "attached", "teaser.blend")
    assert.deepEqual(calls.find(call => call.action === "attach")!.body, { sessionID: "first", offerID: "offer-0002" })
    // Escape closes the choice without attaching.
    model.bindings["first:blender"] = { state: "none" }
    await notify(page, "rpc.neuralnomads.blender.hosts_changed")
    await waitLink(page, "none")
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
    await waitLink(page, "none")
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

/** Clicks the state line and returns the hosts read of that gesture (the row's own display reads are held too). */
async function clickAndHoldHosts(page: Page, model: Routes["model"]) {
  const baseline = model.held.length
  await link(page).click()
  await waitFor(() => model.held.slice(baseline).some(call => call.action === "hosts"), "the gesture's held hosts read")
  return model.held.slice(baseline).find(call => call.action === "hosts")!
}

for (const change of intentChanges) test(`attach intent: ${change} revokes held hosts without submitting or showing an error`, async () => {
  const { page, model, count } = await open(routes => { routes.model.hold.add("hosts") })
  try {
    await waitLink(page, "none")
    const read = await clickAndHoldHosts(page, model)
    const aborted = page.waitForEvent("requestfailed", { predicate: request => request === read.route.request()
      && request.failure()?.errorText === "net::ERR_ABORTED", timeout: 2_000 }).then(() => true, () => false)
    await revokeAttachIntent(page, change)
    await read.route.fulfill({ json: { offers: model.offers } })
    const cancelled = await aborted
    if (change !== "inactive" && change !== "disposed") {
      await page.waitForFunction(() => document.querySelector('[data-plugin-id="neuralnomads.blender"] .plugin-control-state-action')?.getAttribute("aria-busy") === "false")
    }
    assert.equal(count("attach"), 0)
    assert.equal(cancelled, true, "revocation aborts its own enumeration read")
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
      await waitLink(page, "none")
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
    await waitLine(page, "attachMany", "Attach…")
    await link(page).click()
    await page.locator("[data-integration-offers]").waitFor()
    await fx(page, "select", "second")
    await waitLink(page, "none")
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
    await waitLink(page, "none")
    const first = await clickAndHoldHosts(page, model)
    await fx(page, "select", "second")
    await waitLink(page, "none")
    const second = await clickAndHoldHosts(page, model)
    await first.route.fulfill({ json: { offers: model.offers } }).catch(() => {})
    assert.equal(await link(page).getAttribute("aria-busy"), "true")
    assert.equal(count("attach"), 0)
    await second.route.fulfill({ json: { offers: model.offers } })
    await waitLink(page, "attached", "Scene")
    assert.deepEqual(calls.find(call => call.action === "attach")!.body, { sessionID: "second", offerID: "offer-0001" })
  } finally { await page.close() }
})

test("attach intent: an admitted uncertain mutation survives invalidation and navigation without replay", async () => {
  const { page, model, calls, count } = await open(routes => {
    routes.model.hold.add("hosts")
    routes.model.hold.add("attach")
  })
  try {
    await waitLink(page, "none")
    const baseline = model.held.length
    await link(page).focus()
    await page.keyboard.press("Space")
    await waitFor(() => model.held.slice(baseline).some(call => call.action === "hosts"), "one enumeration")
    const reads = count("hosts")
    await link(page).click({ force: true })
    await page.keyboard.press("Enter")
    assert.equal(count("hosts"), reads, "a busy line sends nothing more")
    await model.held.slice(baseline).find(call => call.action === "hosts")!.route.fulfill({ json: { offers: model.offers } })
    await waitFor(() => model.held.some(call => call.action === "attach"), "the admitted attach")
    const mutation = model.held.find(call => call.action === "attach")!
    await fx(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    await fx(page, "select", "second")
    await waitLink(page, "none")
    assert.equal(mutation.route.request().failure(), null, "revocation leaves the admitted mutation alone")
    model.bindings["first:blender"] = { state: "attached", label: "Scene" }
    await mutation.route.abort("connectionfailed")
    await fx(page, "select", "first")
    await waitLink(page, "attached", "Scene")
    assert.equal(count("attach"), 1)
    assert.equal(count("detach"), 0)
    assert.deepEqual(calls.find(call => call.action === "attach")!.body, { sessionID: "first", offerID: "offer-0001" })
  } finally { await page.close() }
})

const blenderStates: Array<[string, string, Record<string, unknown>, Record<string, unknown>?]> = [
  ["install", "Install in Blender", { status: { version: "0.1.0", host: { state: "absent", action: "install" }, connection: { offers: 1 } } }],
  ["update", "Update Blender", { status: { version: "0.1.0", host: { state: "outdated", action: "update" }, connection: { offers: 1 } } }],
  ["incompatible", "Incompatible with this Blender", { status: { version: "0.1.0", host: { state: "incompatible" }, connection: { offers: 1 } } }],
  ["hostClosed", "Blender closed", { status: { version: "0.1.0", host: { state: "unknown" }, connection: { offers: 0 } } }],
  ["noOffer", "Blender: no open document", { status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 0 } } }],
  ["attachOne", "Attach scene.blend", {}],
  ["attachMany", "Attach…", { status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 2 } } }, { second: true }],
  ["attached", "scene.blend", {}, { attached: true }],
]

test("the state line shows one state at a time, the most important, in its tone", async () => {
  for (const dark of [false, true]) {
    const { page, model } = await open(undefined, { dark })
    try {
      await waitLink(page, "none")
      for (const [key, text, overrides, extra] of blenderStates) {
        model.integrations[0] = integrationView("blender", overrides)
        model.offers = [model.offers[0]!, ...(extra?.second ? [{ offerID: "offer-0002", label: "Teaser", document: "teaser.blend", protocol: "ok" }] : [])]
        model.bindings["first:blender"] = extra?.attached ? { state: "attached", label: "Scene" } : { state: "none" }
        await notify(page, "rpc.neuralnomads.blender.hosts_changed")
        await waitLine(page, key, text)
        const tone = await line(page).getAttribute("data-tone")
        assert.equal(tone, ["install", "update", "attachOne", "attachMany", "attached"].includes(key) ? "action" : key === "incompatible" ? "warning" : "info", key)
        const color = await line(page).locator("span, button").first().evaluate(element => getComputedStyle(element).color)
        if (tone === "action") assert.equal(color, await resolved(page, "--accent-primary"), `${key}: accent`)
        else if (tone === "warning") assert.equal(color, await resolved(page, "--status-warning"), `${key}: warning colour`)
        else assert.equal(color, await resolved(page, "--text-muted"), `${key}: muted`)
        assert.equal(await line(page).locator("button").count(), tone === "action" ? 1 : 0)
        if (screenshots) {
          await page.mouse.move(0, 0)
          await row(page).screenshot({ path: join(screenshots, `integration-state-${key}-${dark ? "dark" : "light"}.png`) })
        }
      }
      // The installation entry point is the existing confirmation.
      model.integrations[0] = integrationView("blender", blenderStates[0]![2])
      await notify(page)
      await waitLine(page, "install", "Install in Blender")
      await link(page).click()
      const dialog = confirmation(page, /^Install in application…/)
      await dialog.waitFor()
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
      await dialog.waitFor({ state: "hidden" })
      if (screenshots && !dark) await page.locator(".plugin-controls").screenshot({ path: join(screenshots, "integration-plugins-light.png") })
      if (screenshots && dark) await page.locator(".plugin-controls").screenshot({ path: join(screenshots, "integration-plugins-dark.png") })
    } finally { await page.close() }
  }
})

test("a long state is truncated on one line, with the full text in its title", async () => {
  const document = "a_very_long_document_name_for_the_western_film_final_cut_version_seven.blend"
  const { page } = await open(routes => { routes.model.offers = [{ offerID: "offer-0001", label: "Long", document, protocol: "ok" }] })
  try {
    await waitLine(page, "attachOne", `Attach ${document}`)
    const text = line(page).locator(".plugin-control-state-text")
    assert.ok(await text.evaluate(element => element.scrollWidth > element.clientWidth), "truncated")
    assert.equal(await text.evaluate(element => getComputedStyle(element).textOverflow), "ellipsis")
    assert.equal(await link(page).getAttribute("title"), `Attach ${document}`)
    const box = (await line(page).boundingBox())!
    assert.ok(box.height < 24, "one line")
  } finally { await page.close() }
})

test("the row menu: documentation, application part (re)installation, connection state and removal", async () => {
  const { page, model, count } = await open(routes => {
    routes.model.bindings["first:blender"] = { state: "attached", label: "western_ia.blend" }
  }, { clock: true })
  try {
    await waitLink(page, "attached", "western_ia.blend")
    let menu = await openMenu(page)
    assert.equal((await menu.locator("[data-integration-connection]").innerText()).trim(), "Blender: 1 open document")
    assert.deepEqual(await menuItems(page), ["Documentation", "Reinstall in application…", "Check updates for @neuralnomads/opencode-blender@^0.1",
      "Remove from Global", "Refresh plugin controls"], "detaching belongs to the state line")
    await page.keyboard.press("Escape")

    // The application part is missing: the state line and the menu install it after the guarded confirmation.
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "absent", action: "install" }, connection: { offers: 0 } } })
    await notify(page)
    await waitLine(page, "install", "Install in Blender")
    menu = await openMenu(page)
    assert.equal((await menu.locator("[data-integration-connection]").innerText()).trim(), "Blender: no open document")
    assert.equal((await menuItems(page))[1], "Install in application…")
    await page.keyboard.press("Escape")
    await link(page).click()
    const dialog = confirmation(page, /^Install in application…/)
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /Install the Blender part of OpenCode for Blender 0\.1\.0 on the machine where OpenCode runs\?/)
    const confirm = dialog.getByRole("button", { name: "Install in application…", exact: true })
    assert.equal(await confirm.isDisabled(), true, "the action waits 600 ms")
    await page.clock.fastForward(650)
    await confirm.click()
    await waitFor(() => count("install-host") === 1, "one installHost")
    await page.waitForFunction(() => JSON.stringify((window as any).integrationRow.toasts()).includes("Application part installed."))

    // An outdated part offers Update; a closed application can still be reinstalled.
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "outdated", action: "update" }, connection: { offers: 2 } } })
    await notify(page)
    await openMenu(page)
    assert.equal((await menuItems(page))[1], "Update application…")
    assert.equal((await page.locator("[data-integration-connection]").innerText()).trim(), "Blender: 2 open documents")
    await page.keyboard.press("Escape")
    model.integrations[0] = integrationView("blender", { status: { version: "0.1.0", host: { state: "unknown" }, connection: { offers: 0 } } })
    await notify(page)
    await openMenu(page)
    assert.equal((await page.locator("[data-integration-connection]").innerText()).trim(), "Blender closed")
    await page.getByRole("menuitem", { name: "Reinstall in application…", exact: true }).click()
    const reinstall = confirmation(page, /^Reinstall in application…/)
    await reinstall.waitFor()
    await reinstall.getByRole("button", { name: "Cancel", exact: true }).click()
    await reinstall.waitFor({ state: "hidden" })

    // Removal names the integration and keeps its guarded confirmation.
    await openMenu(page)
    await page.getByRole("menuitem", { name: "Remove from Global", exact: true }).click()
    const removal = confirmation(page, /^Remove from Global — /)
    await removal.waitFor()
    assert.match(await removal.locator("h2").innerText(), /OpenCode for Blender/)
    await removal.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(count("remove"), 0)
    assert.equal(count("install-host"), 1)
  } finally { await page.close() }
})

test("a lost detach answer is reported and read again, never replayed", async () => {
  const { page, model, count } = await open(routes => { routes.model.bindings["first:blender"] = { state: "attached", label: "scene.blend" } })
  try {
    await waitLink(page, "attached", "scene.blend")
    model.fail.set("detach", "network")
    await link(page).click()
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
    await waitLink(page, "none")
    await waitFor(() => calls.filter(call => call.action === "binding" && call.sessionID === "first").length === 2,
      "the initial unknown binding answers")
    model.bindings["first:blender"] = { state: "attached", label: "first.blend" }
    await page.locator("[data-plugin-refresh]").click()
    await waitLink(page, "attached", "first.blend")
    await fx(page, "select", "second")
    await waitLink(page, "none")
    await waitFor(() => calls.filter(call => call.action === "binding" && call.sessionID === "second").length === 2,
      "the new conversation's unknown binding answers")
    const start = calls.length
    model.bindings["second:blender"] = { state: "attached", label: "second.blend" }
    await openMenu(page)
    await page.getByRole("menuitem", { name: "Refresh plugin controls", exact: true }).click()
    await waitLink(page, "attached", "second.blend")
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
    await waitLink(page, "attached", "first.blend")
    const reads = count("binding")
    await link(page).click()
    await waitFor(() => model.held.some(call => call.action === "detach"), "the admitted detach")
    model.bindings["first:blender"] = { state: "none" }
    model.fail.set("binding", 503)
    await model.held.find(call => call.action === "detach")!.route.abort("connectionfailed")
    await waitFor(() => count("binding") > reads, "the failed authoritative reread")
    await waitLink(page, "none")
    model.fail.delete("binding")
    await openMenu(page)
    await page.getByRole("menuitem", { name: "Refresh plugin controls", exact: true }).click()
    await waitLink(page, "none")
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
    await integration.locator('[data-integration-state-line="install"]').waitFor()
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
    model.integrations[0] = { ...model.integrations[0], status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 1 } } }
    await notify(page)
    await integration.locator('[data-integration-state-line="attached"]').waitFor()
    await integration.locator(".plugin-control-state-action").click()
    await integration.locator('[data-integration-state-line="attachOne"]').waitFor()
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
    await waitLink(page, "none")
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
    await waitLink(page, "none")
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
      await page.waitForFunction(() => document.querySelector('[data-plugin-id="neuralnomads.blender"] [data-integration-state-line="attached"]'))
      const label = await link(page).getAttribute("aria-label")
      if (locale === "fr") assert.equal(label, "western_ia.blend — Détacher la conversation")
      else assert.equal(label?.includes("Detach the conversation"), false)
      await page.mouse.move(0, 0)
      await row(page).locator(".plugin-control-identity > button").click()
      const items = await menuItems(page)
      if (locale === "fr") assert.equal(items[1], "Réinstaller dans l'application…")
      assert.equal(items.some(item => /Detach the conversation|Remove from/.test(item)), false, `${locale}: no English fallback`)
      await page.keyboard.press("Escape")
      // Closing the menu returns focus to its trigger first.
      await page.getByRole("menu").waitFor({ state: "hidden" })
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-haspopup") === "true")
      if (locale === "fr") assert.match(await row(page).locator(".plugin-control-name").getAttribute("title") ?? "", /^⁨?Intégration : neuralnomads\.blender/)
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
