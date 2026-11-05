import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page, type Locator } from "playwright"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "preferences-execution-scope", routes: [{ path: "/fixture", html: '<html><body><div id="root" style="height:100vh"></div><script type="module" src="/tests/browser/fixtures/preferences-window.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const request = (serverId: string, section = "providers", instanceId = serverId) => ({ serverId, section, instanceId, workspacePath: "/app", location: { directory: "/app" } })
const workspace = (serverId: string, generation = 1, chat = "available") => ({ id: serverId, path: "/app", status: "ready", proxyPath: `/workspaces/${serverId}/instance`,
  binding: { serverId, directory: "/app" }, capabilities: { serverId, generation, features: {
    chat: { state: chat, reason: { code: "contractVerified" }, evidence: "nativeContract" },
    executionSettings: { state: serverId === "local-shared" ? "available" : "unavailable", reason: { code: "deferred" }, evidence: "e1Policy" },
  } } })
const model = (id: string) => ({ id: "same-model-id", providerID: "provider", name: `${id}-model`, enabled: true, status: "active", cost: [], variants: [], limit: { context: 32000, output: 4000 }, capabilities: { tools: true } })
async function initialize(page: Page, initial: unknown) {
  await page.addInitScript({ content: `{
    const initial = ${JSON.stringify(initial)}, w = window
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.nativeRequest = initial
    w.EventSource = class extends EventTarget { close() {} }
    w.electronAPI = { getPreferencesRequest: async () => w.nativeRequest,
      acceptPreferencesRequest: async value => { w.acceptedRequest = value }, preferencesReady: async () => { w.ready = true },
      onPreferencesSection: callback => { w.changePreferences = callback; return () => {} },
      onPreferencesCloseRequested: () => () => {}, onPreferencesTransitionRequested: () => () => {} }
  }` })
}
const change = (page: Page, value: unknown) => page.evaluate(value => (window as any).changePreferences(value), value)
const dispatch = (page: Page, value: unknown) => page.evaluate(value => (window as any).preferencesFixture.dispatch([value]), value)
const forbidden = (path: string) => /integration|credential|provider-accounts|service-usage|subagent-depth|config-files|filesystem|binaries|opencode\/(?:update|setup|service)/.test(path)

async function tabTo(page: Page, target: Locator) {
  for (let count = 0; count < 40; count++) {
    await page.keyboard.press("Tab")
    if (await target.evaluate(node => node === document.activeElement)) return
  }
  assert.fail("Keyboard Tab did not reach the local backend action")
}

test("explicit catalogues stay on A/B despite identical folders; no integrations/accounts/Stats/depth/host effects", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const calls: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let release: (() => void) | undefined, held = false
  const hold = new Promise<void>(resolve => { release = resolve })
  await initialize(page, request("A"))
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const path = new URL(route.request().url()).pathname
    calls.push(path)
    if (path === "/api/workspaces") return route.fulfill({ json: [workspace("local-shared"), workspace("A"), workspace("B")] })
    if (path.includes("/workspaces/A/")) { held = true; await hold }
    const id = path.includes("/workspaces/B/") ? "B" : "A"
    const json = path.endsWith("/api/provider") ? [{ id: "provider", name: `${id}-provider` }]
      : path.endsWith("/api/model") ? [model(id)] : path.endsWith("/api/agent") ? [{ id: `${id}-agent`, mode: "primary" }]
        : path === "/api/storage/config/ui" ? { settings: { locale: "en" } }
          : path === "/api/meta" ? { host: "127.0.0.1", addresses: [], listeningMode: "local" } : {}
    return route.fulfill({ json: path.includes("/instance/api/") ? { data: json } : json }).catch(() => undefined)
  })
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).ready)
    await page.waitForFunction(() => document.querySelector('[aria-label="Models"]'))
    for (let attempt = 0; !held && attempt < 100; attempt++) await page.waitForTimeout(10)
    assert.ok(held)
    // A handshake delivered before native acceptance must be released without
    // creating/hydrating a main-window instance just to establish event provenance.
    await dispatch(page, { type: "instance.eventStatus", instanceId: "B", status: "connected", generation: 77, source: { serverId: "B", generation: 77 } })
    await change(page, request("B"))
    await page.getByText("B-provider · B-model", { exact: true }).waitFor()
    release!()
    await page.waitForTimeout(100)
    assert.equal(await page.getByText("A-provider · A-model", { exact: true }).count(), 0)
    // Event-source generations and native capability generations are independent counters.
    await dispatch(page, { type: "instance.eventStatus", instanceId: "B", status: "connected", generation: 77, source: { serverId: "B", generation: 77 } })
    await page.getByText("B-provider · B-model", { exact: true }).waitFor()
    await dispatch(page, { type: "instance.eventStatus", instanceId: "B", status: "disconnected", generation: 77, source: { serverId: "B", generation: 77 } })
    await page.getByText(/selected project is unavailable or unresolved/).waitFor()
    const disconnectedCalls = calls.length
    await dispatch(page, { type: "instance.event", instanceId: "B", event: { type: "config.updated", properties: {} } })
    await page.waitForTimeout(100)
    assert.equal(calls.length, disconnectedCalls)
    await dispatch(page, { type: "instance.eventStatus", instanceId: "B", status: "connected", generation: 78, source: { serverId: "B", generation: 78 } })
    await page.getByText("B-provider · B-model", { exact: true }).waitFor()
    assert.match(await page.locator("[data-settings-execution-scope]").innerText(), /B.*\/app/)
    for (const section of ["usage", "missions", "config-files", "advanced", "opencode", "info"]) {
      await change(page, request("B", section))
      await page.waitForFunction(section => (window as any).acceptedRequest?.section === section, section)
      await page.waitForTimeout(80)
    }
    assert.deepEqual(calls.filter(forbidden), [], calls.join("\n"))
    assert.equal(calls.filter(path => path.includes("/workspaces/local-shared/")).length, 0)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, calls, body: (await page.locator("body").innerText()).slice(0, 1600) }); throw error
  } finally { release?.(); await page.close() }
})

test("unresolved, unknown and deleted explicit contexts never mount local readers; shared settings remain selectable", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const calls: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let inventory: any[] = [workspace("A"), workspace("local-shared")]
  await initialize(page, request("missing"))
  await page.route(/\/(?:api|workspaces)\//, route => {
    const path = new URL(route.request().url()).pathname; calls.push(path)
    return route.fulfill({ json: path.includes("/instance/api/") ? { data: [] } : path === "/api/workspaces" ? inventory
      : path === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {} })
  })
  try {
    await page.goto(url)
    await page.getByText(/selected project is unavailable or unresolved/).waitFor()
    for (const section of ["usage", "config-files", "advanced", "opencode", "missions", "general"]) {
      await change(page, request("missing", section))
      await page.waitForFunction(section => (window as any).acceptedRequest?.section === section, section)
      await page.waitForTimeout(60)
    }
    assert.equal(await page.getByRole("button", { name: "General", exact: true }).getAttribute("aria-current"), "page")
    await change(page, request("A"))
    await page.getByText("Read-only native catalogue.", { exact: false }).waitFor()
    await dispatch(page, { type: "workspace.stopped", workspaceId: "A", reason: "deleted" })
    await page.getByText(/selected project is unavailable or unresolved/).waitFor()
    inventory = [{ ...workspace("C"), capabilities: { serverId: "C", generation: 1 } }]
    await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspaces"), change(page, request("C"))])
    await page.waitForFunction(() => (window as any).acceptedRequest?.serverId === "C")
    await page.waitForTimeout(100)
    assert.equal(calls.filter(path => path.includes("/workspaces/C/")).length, 0, "unqualified capability metadata stays inactive")
    assert.deepEqual(calls.filter(forbidden), [], calls.join("\n"))
    assert.equal(calls.filter(path => path.includes("/workspaces/local-shared/")).length, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("local HOME access requires an explicit action on a remote target and retained save callbacks lose authority", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const calls: Array<{ path: string; method: string }> = []
  await initialize(page, request("A", "config-files"))
  // Serve the installed editor assets read-only; this test edits the real Monaco
  // model without rebuilding the checkout's shared browser asset directory.
  const monaco = fileURLToPath(new URL("../../../../node_modules/monaco-editor/min/", import.meta.url))
  await page.route(/^https?:\/\/[^/]+\/monaco\//, route => route.fulfill({ path: path.join(monaco, new URL(route.request().url()).pathname.slice("/monaco/".length)) }))
  await page.route(/\/(?:api|workspaces)\//, route => {
    const path = new URL(route.request().url()).pathname; calls.push({ path, method: route.request().method() })
    return route.fulfill({ json: path === "/api/workspaces" ? [workspace("A"), workspace("B")]
      : path === "/api/config-files" ? [{ id: "opencode", label: "Local HOME", path: "C:/host/HOME/opencode.json" }]
        : path === "/api/config-files/opencode/content" ? { contents: "{}", exists: true }
          : path === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {} })
  })
  try {
    await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspaces"), page.goto(url)])
    const manage = page.getByRole("button", { name: "Manage local backend", exact: true })
    await manage.waitFor()
    await page.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(calls.filter(call => call.path.includes("config-files")).length, 0)
    await manage.evaluate(button => { (window as any).retainedManage = (button as any).$$click })
    await tabTo(page, manage); await page.keyboard.press("Enter")
    assert.equal(await page.getByRole("group", { name: /Local CodeNomad backend/ }).evaluate(node => node === document.activeElement), true)
    const selector = page.locator(".config-files-selector-trigger")
    await page.waitForFunction(() => !document.querySelector(".config-files-selector-trigger")?.hasAttribute("disabled"))
    await page.keyboard.press("Tab")
    assert.equal(await selector.evaluate(node => node === document.activeElement), true, "next Tab enters the newly mounted local controls")
    const save = page.getByRole("button", { name: "Save", exact: true })
    await save.waitFor()
    await page.locator(".monaco-editor").getByRole("textbox").press("Control+End")
    await page.keyboard.type(" ")
    await page.waitForFunction(() => document.querySelector('[aria-label="Save"]')?.hasAttribute("disabled") === false)
    await page.evaluate(() => {
      const button = document.querySelector('[aria-label="Save"]') as any
      if (typeof button.$$click !== "function") throw new Error("Expected actual Solid handler")
      ;(window as any).retainedSave = button.$$click
    })
    await change(page, request("B", "config-files"))
    await page.getByRole("button", { name: "Discard changes", exact: true }).click()
    await manage.waitFor()
    const before = calls.length
    const focusBefore = await page.evaluateHandle(() => document.activeElement)
    await page.evaluate(() => { (window as any).retainedSave(); (window as any).retainedManage() })
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(node => document.activeElement === node, focusBefore), true, "stale handlers preserve focus")
    await focusBefore.dispose()
    assert.equal(calls.slice(before).filter(call => call.path.includes("config-files")).length, 0)
    assert.equal(calls.filter(call => call.method !== "GET" && call.path.includes("config-files")).length, 0)
    await change(page, request("A", "config-files")); await manage.waitFor()
    assert.equal(calls.slice(before).filter(call => call.path.includes("config-files")).length, 0, "A→B→A requires fresh local consent")
    assert.match(await page.getByRole("note").last().innerText(), /Local CodeNomad backend/)
  } finally { await page.close() }
})

test("capability changes revoke the visible catalogue before a held inventory response", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let current = workspace("A"), hold: Promise<void> | undefined, release: (() => void) | undefined
  const nativeCalls: string[] = []
  await initialize(page, request("A"))
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/workspaces") { if (hold) await hold; return route.fulfill({ json: [current] }).catch(() => undefined) }
    if (path.startsWith("/workspaces/")) nativeCalls.push(path)
    return route.fulfill({ json: path.includes("/instance/api/") ? { data: path.endsWith("/api/provider") ? [{ id: "provider", name: "A-provider" }]
      : path.endsWith("/api/model") ? [model("A")] : [] }
        : path === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {} })
  })
  try {
    await page.goto(url); await page.getByText("A-provider · A-model", { exact: true }).waitFor()
    hold = new Promise(resolve => { release = resolve })
    current = workspace("A", 2, "unknown")
    await dispatch(page, { type: "workspace.started", workspace: current })
    await page.getByText(/selected project is unavailable or unresolved/).waitFor()
    const count = nativeCalls.length
    await dispatch(page, { type: "instance.event", instanceId: "A", event: { type: "config.updated", properties: {} } })
    await page.waitForTimeout(100)
    assert.equal(nativeCalls.length, count)
    release!(); hold = undefined
    await page.waitForTimeout(100)
    assert.equal(await page.getByText("A-provider · A-model", { exact: true }).count(), 0)
  } finally { release?.(); await page.close() }
})

test("local service and binary discovery require a deliberate local action; retained install callbacks cannot administer another target", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const calls: Array<{ path: string; method: string }> = []
  await initialize(page, request("A", "opencode"))
  await page.route(/\/(?:api|workspaces)\//, route => {
    const path = new URL(route.request().url()).pathname; calls.push({ path, method: route.request().method() })
    return route.fulfill({ json: path === "/api/workspaces" ? [workspace("A"), workspace("B")]
      : path === "/api/opencode/update" ? { state: "missing", minimumVersion: "2.2.3", recommendedVersion: "2.2.5", binaryPath: "opencode2", target: "host", canUpgrade: true, updateAvailable: true, serviceState: "stopped", canRestart: false }
        : path === "/api/storage/binaries/validate" ? { valid: true, version: "2.2.5" }
          : path === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {} })
  })
  try {
    await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspaces"), page.goto(url)])
    await page.evaluate(() => new Promise(requestAnimationFrame))
    const manage = page.getByRole("button", { name: "Manage local backend", exact: true })
    await manage.waitFor()
    assert.deepEqual(calls.filter(call => forbidden(call.path)), [])
    await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === "/api/storage/binaries/validate"), manage.click()])
    const install = page.getByRole("button", { name: "Install and start OpenCode", exact: true })
    await install.waitFor()
    assert.ok(calls.some(call => call.path === "/api/opencode/update"))
    assert.ok(calls.some(call => call.path === "/api/storage/binaries/validate"))
    await install.evaluate(button => { (window as any).retainedInstall = (button as any).$$click })
    assert.equal(await page.evaluate(() => typeof (window as any).retainedInstall), "function")
    await change(page, request("B", "opencode")); await manage.waitFor()
    const count = calls.length
    await page.evaluate(() => (window as any).retainedInstall())
    await page.waitForTimeout(100)
    assert.deepEqual(calls.slice(count).filter(call => forbidden(call.path)), [])
    assert.equal(calls.filter(call => call.method === "POST" && call.path.startsWith("/api/opencode/")).length, 0)
  } finally { await page.close() }
})

test("Advanced keeps shared choices usable and fences retained environment editor callbacks", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const writes: string[] = []
  await initialize(page, request("A", "advanced"))
  await page.route(/\/(?:api|workspaces)\//, route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== "GET") writes.push(path)
    return route.fulfill({ json: path === "/api/workspaces" ? [workspace("A"), workspace("B")]
      : path === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {} })
  })
  try {
    await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspaces"), page.goto(url)])
    await page.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(await page.locator(".settings-env-disclosure").count(), 0)
    assert.ok(await page.getByText("Hold long assistant replies", { exact: true }).isVisible())
    const manage = page.getByRole("button", { name: "Manage local backend", exact: true })
    await manage.click()
    await page.locator(".settings-env-disclosure > summary").click()
    await page.getByPlaceholder("Variable name", { exact: true }).fill("DEMO_ONLY")
    await page.getByPlaceholder("Variable value", { exact: true }).fill("example")
    await page.getByRole("button", { name: "Add variable", exact: true }).evaluate(button => { (window as any).retainedEnvironmentAdd = (button as any).$$click })
    assert.equal(await page.evaluate(() => typeof (window as any).retainedEnvironmentAdd), "function")
    await change(page, request("B", "advanced")); await manage.waitFor()
    await page.evaluate(() => (window as any).retainedEnvironmentAdd())
    await page.waitForTimeout(100)
    assert.deepEqual(writes, [])
  } finally { await page.close() }
})

test("CSS body zoom can pass internal overflow checks while leaving the real RTL viewport", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 1200 } })
  await initialize(page, request("A", "config-files"))
  await page.route(/\/(?:api|workspaces)\//, route => route.fulfill({ json: new URL(route.request().url()).pathname === "/api/workspaces" ? [workspace("A")]
    : new URL(route.request().url()).pathname === "/api/storage/config/ui" ? { settings: { locale: "he" } } : {} }))
  try {
    await page.goto(url)
    const scope = page.locator("[data-settings-execution-scope]")
    await scope.waitFor()
    await page.evaluate(() => { document.body.style.zoom = "2" })
    const metrics = await scope.evaluate(node => ({ internalFits: node.scrollWidth <= node.clientWidth + 1,
      root: document.getElementById("root")!.getBoundingClientRect().toJSON(), scope: node.getBoundingClientRect().toJSON(),
      viewport: { width: visualViewport!.width, height: visualViewport!.height, scale: visualViewport!.scale } }))
    assert.equal(metrics.internalFits, true, "the original assertion admits the invalid geometry")
    assert.equal(metrics.root.width, 1600)
    assert.ok(metrics.scope.x < 0 || metrics.scope.right > metrics.viewport.width, "visual-viewport bounds reject the artificial zoom")
    const artifacts = fileURLToPath(new URL("../../../../.tmp/scr-1236/", import.meta.url))
    await mkdir(artifacts, { recursive: true })
    await writeFile(path.join(artifacts, "e1-s10-ux-fix-css-zoom-diagnostic.json"), JSON.stringify(metrics, null, 2))
  } finally { await page.close() }
})

for (const scale of [1, 2]) for (const input of ["keyboard", "touch"] as const) test(`Hebrew long target stays in the visual viewport at ${scale * 100}% reflow-equivalent scale with ${input}`, async () => {
  const serverId = "Remote_" + "long_identifier_".repeat(7)
  const folder = "/workspace/" + "long_folder_".repeat(8)
  // Full-page 200% zoom on an 800x1200 surface lays out 400x600 CSS px.
  // This tests that reflow and captures at the original raster size using DPR;
  // it does not invoke Electron/Tauri zoom or emulate physical touch hardware.
  const context = await browser.newContext({ locale: "he-IL", viewport: { width: 800 / scale, height: 1200 / scale }, deviceScaleFactor: scale, hasTouch: input === "touch" })
  const page = await context.newPage(), calls: Array<{ path: string; method: string }> = []
  await initialize(page, { ...request(serverId, "config-files"), workspacePath: folder, location: { directory: folder } })
  await page.route(/\/(?:api|workspaces)\//, route => {
    const path = new URL(route.request().url()).pathname; calls.push({ path, method: route.request().method() })
    return route.fulfill({ json: path === "/api/workspaces" ? [{ ...workspace(serverId), path: folder, binding: { serverId, directory: folder } }]
      : path === "/api/config-files" ? []
      : path === "/api/storage/config/ui" ? { settings: { locale: "he" } } : {} })
  })
  try {
    await page.goto(url)
    const manage = page.getByRole("button", { name: "ניהול השרת המקומי", exact: true })
    await manage.waitFor()
    assert.equal(await page.locator("html").getAttribute("dir"), "rtl")
    const scope = page.locator("[data-settings-execution-scope]")
    assert.match(await scope.innerText(), new RegExp(serverId))
    assert.equal(await scope.locator("bdi").first().innerText(), serverId)
    assert.equal(await scope.locator("bdi").last().innerText(), folder)
    assert.equal(await scope.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
    const reason = page.getByText(/פקדים אלה משפיעים רק/)
    const metrics = await page.evaluate(() => ({ runtime: navigator.userAgent, innerWidth, innerHeight, dpr: devicePixelRatio,
      viewport: { width: visualViewport!.width, height: visualViewport!.height, x: visualViewport!.offsetLeft, y: visualViewport!.offsetTop, scale: visualViewport!.scale },
      root: document.getElementById("root")!.getBoundingClientRect().toJSON() }))
    assert.equal(metrics.root.width, metrics.viewport.width, "root must fit the actual visual viewport")
    const rectangles = []
    for (const target of [scope, reason, manage]) {
      await target.scrollIntoViewIfNeeded()
      const box = await target.boundingBox(); assert.ok(box)
      assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= metrics.viewport.width + 1 && box.y + box.height <= metrics.viewport.height + 1, JSON.stringify({ box, metrics }))
      rectangles.push(box)
    }
    assert.deepEqual(calls.filter(call => forbidden(call.path)), [], "local readers stay inactive before deliberate action")
    const artifacts = fileURLToPath(new URL("../../../../.tmp/scr-1236/", import.meta.url))
    await mkdir(artifacts, { recursive: true })
    const prefix = path.join(artifacts, `e1-s10-ux-fixed-rtl-${scale * 100}-${input}`)
    const capture = await page.screenshot({ path: `${prefix}.png`, fullPage: false })
    assert.ok(capture.length > 10000, "viewport capture must contain rendered content")
    await writeFile(`${prefix}.json`, JSON.stringify({ method: "CSS viewport reflow equivalent + DPR rasterization; not native zoom", input, metrics, rectangles, screenshotBytes: capture.length }, null, 2))
    if (input === "keyboard") { await tabTo(page, manage); await page.keyboard.press("Enter") }
    else {
      await page.evaluate(() => { (window as any).touches = []; document.addEventListener("pointerdown", event => (window as any).touches.push(event.pointerType)) })
      await manage.tap()
      assert.deepEqual(await page.evaluate(() => (window as any).touches), ["touch"])
    }
    await page.locator(".config-files-section").waitFor()
    assert.ok(calls.some(call => call.path === "/api/config-files"))
    assert.equal(await page.getByRole("group", { name: /שרת CodeNomad המקומי/ }).evaluate(node => node === document.activeElement), true)
    assert.deepEqual(calls.filter(call => forbidden(call.path) && call.path !== "/api/config-files"), [])
    assert.equal(calls.filter(call => call.method !== "GET").length, 0)
  } finally { await context.close() }
})

test("the exact local context still mounts provider accounts, Stats owner/cache/aggregation and native depth", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  const calls: string[] = [], errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await initialize(page, request("local-shared"))
  await page.route(/\/(?:api|workspaces)\//, route => {
    const path = new URL(route.request().url()).pathname; calls.push(path)
    const proof = { owner: "local-owner", identity: "local-identity", connection: "local-connection" }, to = Date.now()
    const snapshot = { ...proof, scope: "service", stats: { range: { from: to - 30 * 86400000, to }, sessions: 1, subagents: 0, prompts: 1, steps: 12,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, tools: { mode: "none" }, activeDays: 1, streak: 1, models: [], activity: [] } }
    const data = path.endsWith("/provider") ? [{ id: "provider", name: "Local provider", activation: "enabled" }]
      : path.endsWith("/model") ? [model("Local")]
        : path.endsWith("/integration") ? [{ id: "provider", name: "Local provider", methods: [], connections: [{ type: "credential", id: "local-credential", label: "Local account" }] }] : []
    const json = path === "/api/workspaces" ? [workspace("local-shared"), workspace("A"), workspace("B")]
      : path.includes("/instance/api/") ? { data }
        : path.endsWith("/service-usage/owner") ? proof
          : path.endsWith("/service-usage/cache") ? { ...proof, days: 30 }
            : path.endsWith("/service-usage") ? snapshot
              : path.endsWith("/subagent-depth") ? { location: { directory: "/app" }, capability: { minimum: 0 }, effectiveDepth: 3, project: { path: "/app/opencode.jsonc", depth: null, expectation: "local" } }
                : path.includes("/provider-accounts/") ? { supported: true, enabled: false, logins: {} }
                  : path === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {}
    return route.fulfill({ json })
  })
  try {
    await page.goto(url)
    await page.getByRole("combobox", { name: "Active account", exact: true }).waitFor()
    assert.equal(await page.getByRole("group", { name: /Local CodeNomad backend/ }).count(), 0)
    await change(page, request("local-shared", "usage"))
    await page.locator(".usage-metrics").waitFor()
    assert.ok(calls.some(path => path.endsWith("/service-usage/owner")))
    assert.ok(calls.some(path => path.endsWith("/service-usage/cache")))
    assert.ok(calls.some(path => path.endsWith("/service-usage")))
    await change(page, request("local-shared", "missions"))
    await page.getByText("OpenCode effective depth: 3", { exact: true }).waitFor()
    assert.ok(calls.some(path => path.endsWith("/subagent-depth")))
    assert.ok(calls.some(path => path.endsWith("/integration")))
    assert.ok(calls.some(path => path.includes("/provider-accounts")))
    const before = calls.length
    await change(page, request("A", "usage"))
    await page.getByText(/This feature is unavailable for the selected OpenCode server/).waitFor()
    assert.equal(calls.slice(before).filter(path => path.includes("service-usage") || path.includes("subagent-depth") || path.endsWith("/integration")).length, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
