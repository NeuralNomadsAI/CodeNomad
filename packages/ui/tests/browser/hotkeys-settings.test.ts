import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import { fixtureEventStream } from "./fixture-event-stream"
import { commandHotkeyDefinitions, hotkeyDefinitions } from "../../src/lib/hotkey-definitions"

let server: ViteDevServer, browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>> | undefined
async function closeEvents() {
  const owned = events
  events = undefined
  await owned?.close()
}
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  let ready = false
  await runWithDiagnosticCleanup({ run: async () => {
    server = await createServer({
      configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "hotkeys-settings-fixture", configureServer(s) {
        s.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/fixture", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/hotkeys-settings.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] },
      optimizeDeps: { entries: ["tests/browser/fixtures/hotkeys-settings.tsx"], exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
    events = await fixtureEventStream(url)
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
    ready = true
  }, diagnose: async () => {}, cleanup: async () => {
    if (ready) return
    try { await browser?.close() } finally {
      try { await closeEvents() } finally { if (server) await server.close(); else await cache.dispose() }
    }
  }, onObservationError: () => console.error("hotkeys-startup-observation-failed"),
  onCleanupError: () => console.error("hotkeys-startup-cleanup-failed") })
}, { timeout: 60000 })
after(async () => {
  try { await browser?.close() } finally {
    try { await closeEvents() } finally { await server?.close() }
  }
})

const row = (page: Page, id: string) => page.locator(`[data-hotkey-id="${id}"]`)
async function open(mac = false, host: "web" | "electron" | "tauri" = "web") {
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined, ready = false
  let phase: "context" | "page" | "routes" | "navigation" | "readiness" = "context"
  return runWithDiagnosticCleanup({
    run: async () => {
      context = await browser.newContext()
      phase = "page"
      const page = await context.newPage(), errors: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      phase = "routes"
      if (mac) await page.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" }))
      if (host !== "web") await page.addInitScript(host => {
        ;(window as any).__CODENOMAD_RUNTIME_HOST__ = host
        ;(window as any).__CODENOMAD_WINDOW_CONTEXT__ = "local"
      }, host)
      await page.route("**/api/**", route => route.fulfill({ json: {} }))
      await events!.route(page)
      phase = "navigation"
      await page.goto(url)
      phase = "readiness"
      await page.waitForFunction(() => Boolean((window as any).fixture))
      ready = true
      return { context, page, errors }
    },
    diagnose: async () => { console.error("hotkeys-setup-failed", phase) },
    cleanup: async () => { if (!ready) await context?.close() },
    onObservationError: () => console.error("hotkeys-setup-observation-failed"),
    onCleanupError: () => console.error("hotkeys-setup-cleanup-failed"),
  })
}
async function bind(page: Page, id: string, keys: string) {
  await row(page, id).getByRole("button", { name: "Edit", exact: true }).click()
  const input = row(page, id).getByRole("textbox")
  await input.waitFor()
  await input.press(keys)
  await page.waitForFunction(() => !(window as any).fixture.isRecording())
  await page.waitForFunction(() => !document.querySelector(".hotkeys-toolbar button:disabled"))
}
async function trigger(page: Page, keys: string) {
  await page.locator("#outside").focus()
  await page.keyboard.press(keys)
}

for (const stage of ["newPage", "goto", "waitForFunction"] as const) {
  for (const secondary of [false, true]) test(`hotkeys setup closes immediately after ${stage} failure${secondary ? " with secondary failures" : ""}`, async t => {
    const context = await browser.newContext(), page = await context.newPage()
    const primary = new Error("setup sentinel"), stack = primary.stack
    const close = context.close.bind(context), output: unknown[][] = []
    t.mock.method(console, "error", (...args: unknown[]) => {
      output.push(args)
      if (secondary && args[0] === "hotkeys-setup-failed") throw new Error("private observation sentinel")
    })
    t.mock.method(browser, "newContext", async () => context)
    t.mock.method(context, "newPage", async () => { if (stage === "newPage") throw primary; return page })
    t.mock.method(page, "goto", async () => { if (stage === "goto") throw primary; return null })
    t.mock.method(page, "waitForFunction", async () => { throw primary })
    const closing = t.mock.method(context, "close", async () => {
      await close()
      if (secondary) throw new Error("private cleanup sentinel")
    })
    try {
      await assert.rejects(open(), error => error === primary && (error as Error).stack === stack)
      assert.equal(page.isClosed(), true, "setup closes before rejecting, without browser teardown")
      assert.equal(browser.contexts().includes(context), false)
      assert.equal(closing.mock.callCount(), 1)
      assert.deepEqual(output, [
        ["hotkeys-setup-failed", stage === "newPage" ? "page" : stage === "goto" ? "navigation" : "readiness"],
        ...(secondary ? [["hotkeys-setup-observation-failed"], ["hotkeys-setup-cleanup-failed"]] : []),
      ])
    } finally { await close() }
  })
}

test("assigns initially empty commands, persists, clears and resets them with live conflicts", async () => {
  const { context, page, errors } = await open()
  try {
    assert.equal(await page.locator(".hotkeys-row").count(), hotkeyDefinitions.length)
    assert.equal(await row(page, "new-temporary-instance").locator(".hotkeys-binding").innerText(), "No shortcut")
    assert.equal(await row(page, "open-workspace-editor-vscode").getAttribute("aria-label"), "Open Project in VS Code")
    assert.equal(await page.evaluate(() => (window as any).commandFixture.registered("open-workspace-folder")), false)
    await bind(page, "new-temporary-instance", "Control+Alt+u")
    assert.equal(await page.evaluate(() => (window as any).fixture.temporaryInstances()), 0)
    await trigger(page, "Control+Alt+u")
    assert.equal(await page.evaluate(() => (window as any).fixture.temporaryInstances()), 1)
    await page.locator("#outside").dispatchEvent("keydown", { key: "u", ctrlKey: true, altKey: true, repeat: true })
    assert.equal(await page.evaluate(() => (window as any).fixture.temporaryInstances()), 1, "holding a key does not repeat a command")
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await row(page, "new-temporary-instance").locator(".hotkeys-binding").innerText(), "Ctrl+Alt+U")
    await page.evaluate(() => { (window as any).fixture.setHome(true); (window as any).fixture.setHasInstance(false) })
    await trigger(page, "Control+Alt+u")
    assert.equal(await page.evaluate(() => (window as any).fixture.temporaryInstances()), 1, "application commands also work at home")
    await bind(page, "new-temporary-instance", "Control+n")
    assert.match(await row(page, "new-instance").getByRole("status").innerText(), /New Temporary Instance/)
    assert.match(await row(page, "new-temporary-instance").getByRole("status").innerText(), /New instance/)
    await row(page, "new-temporary-instance").getByRole("button", { name: "Clear shortcut", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector(".hotkeys-toolbar button:disabled"))
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides["new-temporary-instance"]), [])
    assert.equal(await row(page, "new-instance").getByRole("status").count(), 0)
    await row(page, "new-temporary-instance").getByRole("button", { name: "Reset", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector(".hotkeys-toolbar button:disabled"))
    assert.equal(await row(page, "new-temporary-instance").locator(".hotkeys-binding").innerText(), "No shortcut")
    assert.equal(await page.evaluate(() => Object.hasOwn((window as any).fixture.config().settings.hotkeyOverrides, "new-temporary-instance")), false)
    await trigger(page, "Control+Alt+u")
    assert.equal(await page.evaluate(() => (window as any).fixture.temporaryInstances()), 1)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("dispatches real palette actions with their disabled state, session context and modal guards", async () => {
  const { context, page, errors } = await open()
  try {
    await bind(page, "diff-view-unified", "Control+Alt+d")
    await trigger(page, "Control+Alt+d")
    await page.waitForFunction(() => (window as any).commandFixture.preferences().diffViewMode === "unified")
    assert.equal(await page.evaluate(() => (window as any).fixture.config().settings.diffViewMode), "unified")
    await bind(page, "redo", "Control+Alt+r")
    await trigger(page, "Control+Alt+r")
    assert.equal(await page.evaluate(() => (window as any).fixture.redos()), 0, "disabled palette action stays disabled")
    await page.evaluate(() => (window as any).fixture.setRevert(true))
    await trigger(page, "Control+Alt+r")
    assert.equal(await page.evaluate(() => (window as any).fixture.redos()), 1)
    for (const session of [null, "info", "logs"]) {
      await page.evaluate(id => (window as any).fixture.setSessionId(id), session)
      await trigger(page, "Control+Alt+r")
    }
    await page.evaluate(() => { (window as any).fixture.setSessionId("session"); (window as any).fixture.setHome(true) })
    await trigger(page, "Control+Alt+r")
    await page.evaluate(() => { (window as any).fixture.setHome(false); (window as any).fixture.setHasInstance(false) })
    await trigger(page, "Control+Alt+r")
    assert.equal(await page.evaluate(() => (window as any).fixture.redos()), 1, "hidden or missing session cannot receive a command")
    await page.evaluate(() => {
      ;(window as any).fixture.setHasInstance(true)
      const dialog = document.createElement("div")
      dialog.id = "test-modal"; dialog.role = "dialog"; dialog.setAttribute("aria-modal", "true"); document.body.append(dialog)
    })
    await trigger(page, "Control+Alt+r")
    assert.equal(await page.evaluate(() => (window as any).fixture.redos()), 1)
    await page.evaluate(() => { document.querySelector("#test-modal")!.remove(); document.querySelector("#outside")!.setAttribute("role", "combobox") })
    await trigger(page, "Control+Alt+r")
    assert.equal(await page.evaluate(() => (window as any).fixture.redos()), 1)
    await page.evaluate(() => document.querySelector("#outside")!.removeAttribute("role"))
    await trigger(page, "Control+Alt+r")
    assert.equal(await page.evaluate(() => (window as any).fixture.redos()), 2)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

for (const host of ["electron", "tauri"] as const) test(`${host} exposes every palette action once, preserving existing shortcut aliases`, async () => {
  const { context, page, errors } = await open(false, host)
  try {
    const commands = await page.evaluate(() => (window as any).commandFixture.commands()) as { id: string; shortcutId: string }[]
    for (const command of commands) assert.equal(hotkeyDefinitions.filter(item => item.id === command.shortcutId).length, 1, command.id)
    for (const definition of commandHotkeyDefinitions) {
      assert.ok(commands.some(command => command.id === definition.id), definition.id)
      assert.equal(await page.evaluate(id => (window as any).commandFixture.registered(id), definition.id), true, definition.id)
    }
    assert.equal(commands.find(command => command.id === "new-session")?.shortcutId, "session-new")
    assert.equal(commands.find(command => command.id === "open-model-selector")?.shortcutId, "focus-model")
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("rebinds the real dispatcher, updates tooltips, persists and resets with deletion patches", async () => {
  const { context, page, errors } = await open()
  try {
    assert.equal(await page.locator("#outside").getAttribute("title"), "Ctrl+N")
    await trigger(page, "Control+n")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 1)
    await bind(page, "new-instance", "Control+Alt+y")
    assert.equal(await page.locator("#outside").getAttribute("title"), "Ctrl+Alt+Y")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 1, "recording never runs app shortcuts")
    await trigger(page, "Control+n")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 1, "old binding is inert")
    await trigger(page, "Control+Alt+y")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 2)
    const config = await page.evaluate(() => (window as any).fixture.config())
    assert.deepEqual(config.settings.hotkeyOverrides["new-instance"], [{ key: "y", mod: true, alt: true }])
    assert.equal(config.settings.unrelated, "kept")
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.locator("#outside").getAttribute("title"), "Ctrl+Alt+Y")
    await row(page, "new-instance").getByRole("button", { name: "Reset", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("#outside")?.getAttribute("title") === "Ctrl+N")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.patches().at(-1)), { settings: { hotkeyOverrides: { "new-instance": null } } })
    await trigger(page, "Control+Alt+y")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 0)
    await trigger(page, "Control+n")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 1)
    await bind(page, "focus-input", "Control+Alt+i")
    await trigger(page, "Control+p")
    assert.equal(await page.locator("#outside").evaluate(element => document.activeElement === element), true)
    await trigger(page, "Control+Alt+i")
    assert.equal(await page.getByRole("textbox", { name: "Prompt", exact: true }).evaluate(element => document.activeElement === element), true)
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    await row(page, "new-instance").getByRole("button", { name: "Clear shortcut", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("#outside")?.getAttribute("title") === "")
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), false, "clearing also ends recording")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides["new-instance"]), [])
    assert.equal(await row(page, "new-instance").locator(".hotkeys-binding").innerText(), "No shortcut")
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.locator("#outside").getAttribute("title"), "", "disabled binding survives reload")
    await trigger(page, "Control+n")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 0)
    await page.getByRole("button", { name: "Reset all", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("#outside")?.getAttribute("title") === "Ctrl+N")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.patches().at(-1)), { settings: { hotkeyOverrides: null } })
    assert.equal(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides), undefined)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("warns on both conflicting actions, ignores composition/modifier keys and releases recording", async () => {
  const { context, page, errors } = await open()
  try {
    await bind(page, "new-instance", "Control+p")
    assert.match(await row(page, "new-instance").getByRole("status").innerText(), /Focus prompt/)
    assert.match(await row(page, "focus-input").getByRole("status").innerText(), /New instance/)
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    const input = row(page, "new-instance").getByRole("textbox")
    await input.focus()
    for (const event of [{ key: "Dead" }, { key: "Unidentified" }, { key: "Process" }, { key: "Control", ctrlKey: true }, { key: "y", ctrlKey: true, isComposing: true }]) {
      await input.dispatchEvent("keydown", event)
    }
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), true)
    assert.equal(await page.evaluate(() => (window as any).fixture.patches().length), 1)
    await input.press("Tab")
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), false, "Tab navigates away without a focus trap")
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    await row(page, "new-instance").getByRole("button", { name: "Cancel", exact: true }).dispatchEvent("click")
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), false)
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), false, "window blur releases renderer recording")
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    await row(page, "new-instance").getByRole("textbox").dispatchEvent("keydown", { key: "Tab", code: "Tab", ctrlKey: true })
    await page.waitForFunction(() => !(window as any).fixture.isRecording() && !document.querySelector(".hotkeys-toolbar button:disabled"))
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides["new-instance"]), [{ key: "tab", mod: true }])
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    await page.evaluate(() => (window as any).fixture.setVisible(false))
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), false, "disposal releases global suppression")
    await page.evaluate(() => (window as any).fixture.setVisible(true))
    await page.getByRole("searchbox", { name: "Filter shortcuts" }).fill("App tab 9")
    assert.equal(await page.locator(".hotkeys-row").count(), 1)
    assert.equal(await row(page, "app-tab-9").count(), 1, "static numbered catalog works without app registration")
    await page.getByRole("searchbox", { name: "Filter shortcuts" }).fill("New instance")
    await page.evaluate(() => (window as any).fixture.failSave(true))
    await bind(page, "new-instance", "Control+Alt+y")
    assert.match(await page.getByRole("alert").innerText(), /Could not save/)
    assert.equal(await page.locator("#outside").getAttribute("title"), "Ctrl+Tab", "failed writes retain old binding")
    await row(page, "new-instance").getByRole("button", { name: "Clear shortcut", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector(".hotkeys-toolbar button:disabled"))
    assert.equal(await row(page, "new-instance").locator(".hotkeys-binding").innerText(), "Ctrl+Tab", "a failed clear retains the saved shortcut")
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("captures portable Mod on macOS and keeps narrow settings controls square and reachable", async () => {
  const { context, page, errors } = await open(true)
  try {
    assert.equal(await page.locator("#outside").getAttribute("title"), "⌘+N")
    await bind(page, "new-instance", "Meta+Alt+y")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides["new-instance"]), [{ key: "y", mod: true, alt: true }])
    assert.equal(await page.locator("#outside").getAttribute("title"), "⌘+⌥+Y")
    await trigger(page, "Meta+Alt+y")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 1)
    await page.setViewportSize({ width: 390, height: 600 })
    await page.getByRole("searchbox", { name: "Filter shortcuts" }).fill("New instance")
    assert.equal(await page.locator(".hotkeys-settings").evaluate(element => element.scrollWidth <= element.clientWidth), true)
    assert.equal(await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).evaluate(element => getComputedStyle(element).borderRadius), "0px")
    await row(page, "new-instance").getByRole("button", { name: "Clear shortcut", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("#outside")?.getAttribute("title") === "")
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

for (const [layout, key, code, physical, other] of [
  ["AZERTY", "&", "Digit1", "1", "app-tab-1"],
  ["QWERTZ", "ü", "BracketLeft", "[", "instance-prev"],
]) test(`records ${layout} physical identity, warns on both rows and dispatches the recorded binding`, async () => {
  const { context, page, errors } = await open()
  try {
    await row(page, "focus-input").getByRole("button", { name: "Edit", exact: true }).click()
    const input = row(page, "focus-input").getByRole("textbox")
    await input.waitFor()
    await input.dispatchEvent("keydown", { key, code, ctrlKey: true })
    await page.waitForFunction(() => !(window as any).fixture.isRecording() && !document.querySelector(".hotkeys-toolbar button:disabled"))
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides["focus-input"]), [{ key: physical, mod: true }])
    assert.match(await row(page, "focus-input").getByRole("status").innerText(), /also assigned to/)
    assert.match(await row(page, other).getByRole("status").innerText(), /Focus prompt/)
    // Conflicts are advisory, not a silent disable. Remove the competing action
    // explicitly so its dispatcher priority cannot obscure the captured action.
    await row(page, other).getByRole("button", { name: "Clear shortcut", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector(".hotkeys-toolbar button:disabled"))
    assert.equal(await row(page, "focus-input").getByRole("status").count(), 0)
    await page.locator("#outside").focus()
    await page.locator("#outside").dispatchEvent("keydown", { key, code, ctrlKey: true })
    assert.equal(await page.getByRole("textbox", { name: "Prompt", exact: true }).evaluate(element => document.activeElement === element), true)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("hotkeys owns a persistent native EventSource until context and event-server cleanup", async t => {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  const previousEvents = events
  events = await fixtureEventStream(url)
  const owned = events, close = owned.close.bind(owned)
  t.after(async () => {
    try { if (events === owned) await closeEvents() } finally { events = previousEvents }
  })
  t.mock.method(browser, "newContext", async () => context)
  t.mock.method(context, "newPage", async () => page)
  await page.clock.install()
  await page.addInitScript(() => localStorage.setItem("opencode:logger:namespaces", '["sse"]'))
  let requests = 0
  const failures: string[] = []
  page.on("request", request => { if (request.resourceType() === "eventsource") requests++ })
  page.on("requestfailed", request => { if (request.resourceType() === "eventsource") failures.push("stream-request-failed") })
  page.on("console", message => { if (/MIME|scheduling reconnect|failed to connect/i.test(message.text())) failures.push("stream-console-error") })
  const response = page.waitForResponse(response => response.request().resourceType() === "eventsource")
  const opened = page.waitForEvent("console", message => message.text().includes("Events stream connected"))
  const closing = t.mock.method(owned, "close", async () => {
    assert.equal(page.isClosed(), true, "the page owns the connection lifetime")
    await close()
  })
  try {
    const fixture = await open()
    assert.equal(fixture.context, context)
    assert.equal(page.isClosed(), false, "successful setup transfers its context to the caller")
    assert.equal((await response).headers()["content-type"], "text/event-stream")
    await opened
    await page.clock.runFor(1500)
    assert.equal(requests, 1, "a live stream does not retry or hit the JSON fallback")
    assert.deepEqual(failures, [])
    assert.deepEqual(fixture.errors, [])
  } finally { try { await context.close() } finally { await closeEvents() } }
  await closeEvents()
  assert.equal(closing.mock.callCount(), 1, "the suite releases only its owned event server once")
})
