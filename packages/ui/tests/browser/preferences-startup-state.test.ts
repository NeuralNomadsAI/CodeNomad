import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, origin: string
before(async () => {
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "preferences-startup-state", configureServer(s) {
      const page = (path: string, script: string) => s.middlewares.use(path, async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml(path, `<html><body><div id="root" style="height:100vh"></div><script type="module" src="${script}"></script></body></html>`))
      })
      page("/preferences", "/src/main.tsx")
      page("/owner", "/tests/browser/fixtures/startup-state-owner.tsx")
    } }],
    resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

// Simulates the native host: it alone knows which local window opened
// Preferences, forwards fixed commands to it, and fences stale epochs.
const HOST_SCRIPT = `
  const w = window
  w.fixtureHost = {
    opener: "window-a", epoch: 1, readDelay: 0, commands: [], clientStateCalls: [],
    windows: { "window-a": { isPrimary: true, restoreEnabled: true }, "window-b": { isPrimary: true, restoreEnabled: true } },
    async run(command, epoch) {
      const host = w.fixtureHost
      const opener = host.opener, current = host.epoch
      const effective = command !== "read" && epoch !== current ? "read" : command
      const target = opener && host.windows[opener]
      host.commands.push({ command, epoch, opener, effective })
      if (effective === "read" && host.readDelay) await new Promise(resolve => setTimeout(resolve, host.readDelay))
      if (!target) return { epoch: current, state: null, applied: false }
      if (effective === "enable-restore") target.restoreEnabled = true
      if (effective === "disable-restore") target.restoreEnabled = false
      return { epoch: current, state: { ...target }, applied: effective !== "read" }
    },
    switchOpener(id) { if (id !== w.fixtureHost.opener) { w.fixtureHost.opener = id; w.fixtureHost.epoch += 1 } },
  }
  const forbidden = name => (...args) => { w.fixtureHost.clientStateCalls.push(name); return Promise.resolve(false) }
`

async function openPreferences(host: "electron" | "tauri") {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    ${HOST_SCRIPT}
    w.__CODENOMAD_RUNTIME_HOST__ = ${JSON.stringify(host)}
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.electronAPI = ${JSON.stringify(host)} === "electron" ? {
      getPreferencesRequest: async () => ({ section: "general" }),
      acceptPreferencesRequest: async () => {},
      preferencesReady: async () => { w.fixtureReady = true },
      onPreferencesSection: () => () => {},
      onPreferencesCloseRequested: () => () => {},
      onPreferencesTransitionRequested: () => () => {},
      openerStartupState: (command, epoch) => w.fixtureHost.run(command, epoch),
      claimClientStateAccess: forbidden("claim"), loadClientState: forbidden("load"),
      saveClientState: forbidden("save"), commitClientStatePartitions: forbidden("commit"),
      setClientStateRestoreEnabled: forbidden("setRestore"), clearClientState: forbidden("clear"),
    } : undefined
    if (${JSON.stringify(host)} === "tauri") {
      w.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command.startsWith("client_state_")) { w.fixtureHost.clientStateCalls.push(command); return false }
          if (command === "preferences_opener_startup_state") return w.fixtureHost.run(args.command, args.epoch ?? undefined)
          if (command === "preferences_get_request") return { section: "general" }
          if (command === "preferences_window_ready") w.fixtureReady = true
          return 1
        },
      }
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }
  }` })
  await page.route("**/api/**", route => new URL(route.request().url()).pathname.startsWith("/api/")
    ? route.fulfill({ json: new URL(route.request().url()).pathname === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {} })
    : route.continue())
  await page.goto(`${origin}/preferences?preferences=general`)
  await page.waitForFunction(() => (window as any).fixtureReady)
  return { page, errors }
}

const restore = (page: Page) => page.getByRole("checkbox", { name: "Restore previous state" })
const hostState = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).fixtureHost)))
const refocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")))

for (const host of ["electron", "tauri"] as const) {
  test(`${host} Preferences manages startup state of the exact opener window`, async () => {
    const { page, errors } = await openPreferences(host)
    try {
      await page.getByText("Applies to the CodeNomad window that opened Preferences.").waitFor()
      assert.equal(await restore(page).isChecked(), true)
      assert.equal(await restore(page).isEnabled(), true)

      await restore(page).click()
      await page.waitForFunction(() => (window as any).fixtureHost.windows["window-a"].restoreEnabled === false)
      await page.waitForFunction(() => !(document.querySelector('[data-testid="startup-state-settings"] input') as HTMLInputElement).checked)
      let state = await hostState(page)
      assert.deepEqual(state.commands.at(-1), { command: "disable-restore", epoch: 1, opener: "window-a", effective: "disable-restore" })
      assert.equal(state.windows["window-b"].restoreEnabled, true)

      // Settings is reopened from window B: a slow read from A must not win.
      await page.evaluate(() => { (window as any).fixtureHost.readDelay = 300 })
      await refocus(page)
      await page.evaluate(() => { const h = (window as any).fixtureHost; h.readDelay = 0; h.switchOpener("window-b") })
      await refocus(page)
      await page.waitForFunction(() => (window as any).fixtureHost.commands.length >= 4)
      await page.waitForTimeout(400)
      assert.equal(await restore(page).isChecked(), true, "B's value must survive A's late response")

      // The opener changes again before the card refreshes: a toggle prepared
      // against B is fenced by the host and never applied to A or B.
      await page.evaluate(() => (window as any).fixtureHost.switchOpener("window-a"))
      await restore(page).click()
      await page.getByText("Could not update the startup restore setting.").waitFor()
      await page.waitForFunction(() => !(document.querySelector('[data-testid="startup-state-settings"] input') as HTMLInputElement).checked)
      state = await hostState(page)
      assert.equal(state.windows["window-a"].restoreEnabled, false)
      assert.equal(state.windows["window-b"].restoreEnabled, true)
      assert.ok(state.commands.some((entry: any) => entry.command === "disable-restore" && entry.epoch === 2 && entry.effective === "read"))

      // The opener closes: the setting stays visible, truthful and unavailable.
      await page.evaluate(() => { delete (window as any).fixtureHost.windows["window-a"] })
      await refocus(page)
      await page.getByText("The window that opened Preferences is closed or unavailable.", { exact: false }).waitFor()
      assert.equal(await restore(page).isVisible(), true)
      assert.equal(await restore(page).isDisabled(), true)
      assert.equal(await page.getByRole("button", { name: "Clear saved state" }).isDisabled(), true)

      state = await hostState(page)
      assert.deepEqual(state.clientStateCalls, [], "Preferences must never use client-state authority")
      assert.ok(state.commands.every((entry: any) => entry.effective === "read" || entry.epoch !== undefined))
      assert.deepEqual(errors, [])
    } catch (error) {
      console.error({ host, errors, content: (await page.locator("body").innerText()).slice(0, 800) })
      throw error
    } finally { await page.close() }
  })
}

test("the opener runs forwarded commands through its own client-state store; inline settings are unchanged", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"
    w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    w.nativeCalls = []
    w.electronAPI = {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }),
      saveClientState: async (_token, snapshot) => { w.nativeCalls.push(["save", snapshot.session?.tabs?.map(tab => tab.folder) ?? null]); return true },
      setClientStateRestoreEnabled: async (_token, enabled) => { w.nativeCalls.push(["setRestore", enabled]); return true },
      clearClientState: async () => { w.nativeCalls.push(["clear"]); return true },
    }
  }` })
  await page.route("**/api/**", route => new URL(route.request().url()).pathname.startsWith("/api/")
    ? route.fulfill({ json: {} }) : route.continue())
  try {
    await page.goto(`${origin}/owner`)
    await restore(page).waitFor()
    assert.equal(await restore(page).isChecked(), true)
    assert.equal(await page.getByText("Applies to the CodeNomad window that opened Preferences.").count(), 0)
    await page.evaluate(() => (window as any).ownerFixture.capture("D:/main-work"))
    const run = (command: string) => page.evaluate(command => (window as any).__CODENOMAD_STARTUP_STATE_COMMAND__(command), command)

    assert.deepEqual(await run("read"), { isPrimary: true, restoreEnabled: true })
    assert.deepEqual(await run("disable-restore"), { isPrimary: true, restoreEnabled: false })
    await page.waitForFunction(() => !(document.querySelector('[data-testid="startup-state-settings"] input') as HTMLInputElement).checked)
    // While disabled the owner's store refuses to persist sessions.
    await page.evaluate(() => (window as any).ownerFixture.capture("D:/ignored"))
    assert.deepEqual(await run("enable-restore"), { isPrimary: true, restoreEnabled: true })
    assert.equal(await restore(page).isChecked(), true)
    assert.deepEqual(await run("clear"), { isPrimary: true, restoreEnabled: true })
    await assert.rejects(run("save"), /Invalid startup state command/)

    // Inline settings still use the window's own store directly.
    await restore(page).click()
    await page.waitForFunction(() => (window as any).nativeCalls.at(-1)?.[1] === false)
    assert.deepEqual(await page.evaluate(() => (window as any).nativeCalls), [
      ["save", ["D:/main-work"]], ["setRestore", false], ["setRestore", true], ["clear"], ["setRestore", false],
    ])
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, calls: await page.evaluate(() => (window as any).nativeCalls).catch(() => null) })
    throw error
  } finally { await page.close() }
})
