import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let browser: Browser, server: ViteDevServer, url: string
before(async () => {
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: "node_modules/.vite-desktop-updates", resolve: { dedupe: ["solid-js"] },
    plugins: [solid(), { name: "updater-fixture", configureServer(server) {
      server.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await server.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/desktop-updates.tsx"></script></body></html>'))
      })
    } }], server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function fixture(scenario: string, host = "tauri", context = "local", meta: object = {}, query = ""): Promise<Page> {
  // The Preferences card follows the browser locale.
  const page = await browser.newPage({ locale: "en-US" })
  page.on("pageerror", error => console.error("updater fixture:", error.message))
  // The Preferences card also loads configuration, which must not receive the metadata.
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify(query && new URL(route.request().url()).pathname !== "/api/meta" ? {} : meta) }))
  await page.addInitScript(({ scenario, host, context }) => {
    const w = window as any
    w.__name = (value: unknown) => value
    w.__CODENOMAD_RUNTIME_HOST__ = host
    w.__CODENOMAD_WINDOW_CONTEXT__ = context
    w.calls = []
    w.failurePending = scenario === "reloaded-failure"
    const callbacks = new Map<number, Function>()
    const listeners = new Map<string, number>()
    let sequence = 0
    w.__TAURI__ = {}
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: Function) => { callbacks.set(++sequence, callback); return sequence },
      invoke: async (command: string, args: any) => {
        w.calls.push({ command, args })
        if (command === "plugin:event|listen") { listeners.set(args.event, args.handler); return args.handler }
        if (command === "check_desktop_update") {
          if (scenario === "check-error") throw new Error("unavailable endpoint")
          if (scenario === "slow-check") await new Promise<void>(resolve => { w.finishCheck = resolve })
          if (scenario === "current-after-check" && w.calls.filter((c: any) => c.command === command).length > 1) return { status: "current" }
          if (scenario === "busy") return { status: "busy" }
          return scenario === "unsigned" ? { status: "unsupported" }
            : scenario === "current" ? { status: "current" } : { status: "available", version: "0.21.0" }
        }
        if (command === "install_desktop_update") {
          if (scenario === "signature-error") throw new Error("invalid signature")
          if (scenario.startsWith("download-error")) {
            // Native records the failure before rejecting; only event delivery may lag.
            w.failurePending = true
            if (scenario === "download-error-event-first") { w.deliverFailure(); await new Promise(r => setTimeout(r, 50)) }
            else setTimeout(() => w.deliverFailure(), 50)
            throw new Error("download stalled")
          }
          await new Promise<void>(resolve => { w.finishDownload = resolve })
        }
        if (command === "take_desktop_update_failure") {
          // `true`: owned by this webview; "other": owned by another live window.
          if (w.failurePending !== true) return false
          w.failurePending = false
          return true
        }
      },
    }
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (event: string) => listeners.delete(event) }
    w.deliverFailure = () => callbacks.get(listeners.get("desktop-update:failed")!)?.({ payload: null })
    w.emitFailure = (owner: true | "other" = true) => {
      w.failurePending = owner
      w.deliverFailure()
    }
    w.open = (url: string) => { w.calls.push({ command: "web-open", args: { url } }); return {} }
  }, { scenario, host, context })
  await page.goto(url + query)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return page
}

test("unsigned Tauri, Electron and remote windows use downloads without installing", async () => {
  for (const [host, context] of [["tauri", "local"], ["electron", "local"], ["tauri", "remote"]]) {
    const page = await fixture("unsigned", host, context)
    try {
      await page.getByRole("button", { name: "Check updates" }).click()
      await page.waitForFunction(() => (window as any).calls.some((c: any) => c.command === "plugin:opener|open_url" || c.command === "web-open"))
      const calls = await page.evaluate(() => (window as any).calls)
      assert.equal(calls.filter((c: any) => c.command === "install_desktop_update").length, 0)
      assert.equal(calls.filter((c: any) => c.command === "check_desktop_update").length, host === "tauri" && context === "local" ? 1 : 0)
    } finally { await page.close() }
  }
})

test("installation needs an explicit action; duplicate gestures and shutdown failure do not replay it", async () => {
  const page = await fixture("available")
  try {
    await page.getByRole("button", { name: "Check updates" }).click()
    await page.getByText(/CodeNomad 0.21.0 is available/).waitFor()
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "install_desktop_update").length), 0)
    await page.getByRole("button", { name: "Install and restart" }).click()
    await page.getByText("Downloading and verifying the update…").waitFor()
    await page.getByRole("button", { name: "Install and restart" }).waitFor({ state: "hidden" })
    await page.evaluate(() => (window as any).fixture.check())
    await page.evaluate(() => (window as any).finishDownload())
    await page.getByText("Saving windows and installing the update…").waitFor()
    await page.evaluate(() => (window as any).emitFailure())
    await page.getByText(/The update could not be completed/).waitFor()
    const calls = await page.evaluate(() => (window as any).calls)
    assert.deepEqual(calls.filter((c: any) => c.command === "install_desktop_update").map((c: any) => c.args), [{ version: "0.21.0" }])
    assert.equal(calls.filter((c: any) => c.command === "check_desktop_update").length, 1)
  } finally { await page.close() }
})

test("check and signature failures stay recoverable; current versions never offer installation", async () => {
  for (const scenario of ["check-error", "signature-error", "current"]) {
    const page = await fixture(scenario)
    try {
      await page.getByRole("button", { name: "Check updates" }).click()
      if (scenario === "signature-error") await page.getByRole("button", { name: "Install and restart" }).click()
      await page.getByText(scenario === "current" ? "CodeNomad is up to date." : /The update could not be completed/).waitFor()
      await page.getByRole("button", { name: "Install and restart" }).waitFor({ state: "hidden" })
      assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "install_desktop_update").length), scenario === "signature-error" ? 1 : 0)
      // Recoverable: the flow accepts a new check afterwards.
      await page.getByRole("button", { name: "Check updates" }).click()
      await page.waitForFunction(() => (window as any).calls.filter((c: any) => c.command === "check_desktop_update").length === 2)
    } finally { await page.close() }
  }
})

test("a fresh check removes the previous install offer when no update remains", async () => {
  const page = await fixture("current-after-check")
  try {
    await page.getByRole("button", { name: "Check updates" }).click()
    await page.getByRole("button", { name: "Install and restart" }).waitFor()
    await page.getByRole("button", { name: "Check updates" }).click()
    await page.getByText("CodeNomad is up to date.").waitFor()
    await page.getByRole("button", { name: "Install and restart" }).waitFor({ state: "hidden" })
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "install_desktop_update").length), 0)
  } finally { await page.close() }
})

async function serveMeta(page: Page, meta: object) {
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(meta) }))
}

const notificationMeta = (feed?: string) => ({
  updateFeed: feed,
  support: { supported: false, latestServerVersion: "0.21.0", latestServerUrl: "https://example.com/release" },
  update: { version: "0.21.0-dev-20261020-aaaaaaaa", url: "https://example.com/preview" },
})

const notificationAction = (page: Page, title: string) => page.locator("div")
  .filter({ hasText: title }).filter({ has: page.getByRole("button", { name: "Get update" }) })
  .last().getByRole("button", { name: "Get update" })

const openedUrls = (page: Page) => page.evaluate(() =>
  (window as any).calls.filter((c: any) => c.command === "plugin:opener|open_url").map((c: any) => c.args.url))

test("support and preview notifications check the saved feed natively", async () => {
  for (const title of ["Upgrade required", "Update available"]) {
    for (const feed of ["stable", "preview", undefined]) {
      const page = await fixture("available")
      try {
        await serveMeta(page, notificationMeta(feed))
        await page.evaluate(() => (window as any).fixture.releases())
        await notificationAction(page, title).click()
        await page.getByRole("button", { name: "Install and restart" }).waitFor()
        const calls = await page.evaluate(() => (window as any).calls)
        // An unknown feed lets the native host derive it from the installed build.
        assert.deepEqual(calls.filter((c: any) => c.command === "check_desktop_update").map((c: any) => c.args.feed), [feed])
        assert.equal(calls.filter((c: any) => c.command === "install_desktop_update").length, 0)
        assert.deepEqual(await openedUrls(page), [])
      } finally { await page.close() }
    }
  }
})

test("a notified release that cannot be installed in place opens its own release page", async () => {
  // "current": not yet published with a manifest; "unsigned": this installation cannot update.
  for (const scenario of ["current", "unsigned"])
  for (const [title, url] of [["Upgrade required", "https://example.com/release"], ["Update available", "https://example.com/preview"]]) {
    const page = await fixture(scenario)
    try {
      await serveMeta(page, notificationMeta("preview"))
      await page.evaluate(() => (window as any).fixture.releases())
      await notificationAction(page, title).click()
      await page.waitForFunction(() => (window as any).calls.some((c: any) => c.command === "plugin:opener|open_url"))
      assert.deepEqual(await openedUrls(page), [url])
      assert.equal(await page.getByText("CodeNomad is up to date.").count(), 0)
    } finally { await page.close() }
  }
})

test("the Preferences update button installs in place, or opens the release it shows", async () => {
  const meta = {
    localUrl: "http://127.0.0.1:9899", host: "127.0.0.1", listeningMode: "local", localPort: 9899, workspaceRoot: "/fixture",
    addresses: [], serverVersion: "0.20.0", ui: { version: "0.20.0", source: "bundled" }, updateFeed: "preview",
    update: { version: "0.21.0-dev-20261020-aaaaaaaa", url: "https://example.com/preview" },
  }
  // Tauri shows this card in the separate Preferences window, which must be allowed to update.
  const capability = JSON.parse(await readFile(fileURLToPath(new URL("../../../tauri-app/src-tauri/capabilities/preferences-window.json", import.meta.url)), "utf8"))
  for (const permission of ["allow-check-desktop-update", "allow-install-desktop-update", "allow-take-desktop-update-failure"]) {
    assert.ok(capability.permissions.includes(permission), permission)
  }
  const available = await fixture("available", "tauri", "preferences", meta, "?settings")
  try {
    await available.getByRole("button", { name: "Install update" }).click()
    await available.getByText(/CodeNomad 0.21.0 is available/).waitFor()
    const checks = await available.evaluate(() => (window as any).calls.filter((c: any) => c.command === "check_desktop_update"))
    assert.deepEqual(checks.map((c: any) => c.args.feed), ["preview"])
    assert.deepEqual(await openedUrls(available), [])
    // Preferences owns the install; a failure delivered live (it kept its page) is reported once.
    await available.getByRole("button", { name: "Install and restart" }).click()
    await available.evaluate(() => (window as any).finishDownload())
    await available.evaluate(() => (window as any).emitFailure())
    await available.getByText(/The update could not be completed/).waitFor()
    assert.equal(await available.getByText(/The update could not be completed/).count(), 1)
  } finally { await available.close() }

  const unsigned = await fixture("unsigned", "tauri", "preferences", meta, "?settings")
  try {
    await unsigned.getByRole("button", { name: "Install update" }).click()
    await unsigned.waitForFunction(() => (window as any).calls.some((c: any) => c.command === "plugin:opener|open_url"))
    assert.deepEqual(await openedUrls(unsigned), ["https://example.com/preview"])
  } finally { await unsigned.close() }

  // Without the native updater (Electron, remote windows) the card keeps its download link.
  for (const [host, context] of [["electron", "local"], ["tauri", "remote"]]) {
    const page = await fixture("available", host, context, meta, "?settings")
    try {
      await page.getByRole("link", { name: "Download update" }).waitFor()
      assert.equal(await page.getByRole("link", { name: "Download update" }).getAttribute("href"), "https://example.com/preview")
      assert.equal(await page.getByRole("button", { name: "Install update" }).count(), 0)
      assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "check_desktop_update").length), 0)
    } finally { await page.close() }
  }
})

test("another window's update in progress is not reported as a failure", async () => {
  const page = await fixture("busy")
  try {
    await page.getByRole("button", { name: "Check updates" }).click()
    await page.getByText("Another CodeNomad window is already checking for or installing an update.").waitFor()
    assert.equal(await page.getByText(/The update could not be completed/).count(), 0)
    // A notification still leads to the release it announces.
    await serveMeta(page, notificationMeta("preview"))
    await page.evaluate(() => (window as any).fixture.releases())
    await notificationAction(page, "Update available").click()
    await page.waitForFunction(() => (window as any).calls.some((c: any) => c.command === "plugin:opener|open_url"))
    assert.deepEqual(await openedUrls(page), ["https://example.com/preview"])
  } finally { await page.close() }
})

test("a stalled backend does not hold the check; the native host derives the feed", async () => {
  const page = await fixture("available")
  try {
    await page.route("**/api/**", () => { /* never answers */ })
    await page.getByRole("button", { name: "Check updates" }).click()
    await page.getByRole("button", { name: "Install and restart" }).waitFor({ timeout: 15000 })
    assert.deepEqual(await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "check_desktop_update").map((c: any) => c.args.feed)), [undefined])
  } finally { await page.close() }
})

test("release pages follow the feed: previews list every release", async () => {
  const list = "https://github.com/NeuralNomadsAI/CodeNomad/releases"
  // An unknown feed uses the full list, which contains every offered release.
  for (const [feed, url] of [["preview", list], ["stable", `${list}/latest`], [undefined, list]]) {
    const unsigned = await fixture("unsigned")
    try {
      await serveMeta(unsigned, { updateFeed: feed })
      await unsigned.getByRole("button", { name: "Check updates" }).click()
      await unsigned.waitForFunction(() => (window as any).calls.some((c: any) => c.command === "plugin:opener|open_url"))
      assert.deepEqual(await openedUrls(unsigned), [url])
    } finally { await unsigned.close() }

    // A reloaded document reads the feed before offering the failure's release link.
    const reloaded = await fixture("reloaded-failure", "tauri", "local", { updateFeed: feed })
    try {
      await reloaded.getByText(/The update could not be completed/).waitFor()
      await reloaded.getByRole("button", { name: "Get update" }).click()
      await reloaded.waitForFunction(() => (window as any).calls.some((c: any) => c.command === "plugin:opener|open_url"))
      assert.deepEqual(await openedUrls(reloaded), [url])
    } finally { await reloaded.close() }
  }
})

test("an install offer retained in notification history re-checks instead of installing", async () => {
  const page = await fixture("available")
  try {
    for (let check = 1; check <= 2; check++) {
      await page.getByRole("button", { name: "Check updates" }).click()
      await page.waitForFunction((count) => (window as any).calls.filter((c: any) => c.command === "check_desktop_update").length === count, check)
      // The replaced offer may still be animating out.
      await page.getByRole("button", { name: "Install and restart" }).last().waitFor()
    }
    await page.evaluate(() => (window as any).fixture.runHistoryAction("Install and restart"))
    await page.waitForFunction(() => (window as any).calls.filter((c: any) => c.command === "check_desktop_update").length === 3)
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "install_desktop_update").length), 0)
  } finally { await page.close() }
})

test("a download failure that is both emitted and rejected is reported once", async () => {
  for (const scenario of ["download-error-event-first", "download-error-reject-first"]) {
    const page = await fixture(scenario)
    try {
      await page.getByRole("button", { name: "Check updates" }).click()
      await page.getByRole("button", { name: "Install and restart" }).click()
      await page.getByText(/The update could not be completed/).waitFor()
      await page.waitForTimeout(300)
      const reports = await page.evaluate(() => (window as any).fixture.history()
        .filter((message: string) => /could not be completed/.test(message)).length)
      assert.equal(reports, 1, scenario)
      assert.equal(await page.evaluate(() => (window as any).failurePending), false)
    } finally { await page.close() }
  }
})

test("a document that is only checking leaves another window's install failure alone", async () => {
  const page = await fixture("slow-check")
  try {
    await page.getByRole("button", { name: "Check updates" }).click()
    await page.waitForFunction(() => typeof (window as any).finishCheck === "function")
    await page.evaluate(() => (window as any).emitFailure("other"))
    await page.evaluate(() => (window as any).finishCheck())
    await page.getByRole("button", { name: "Install and restart" }).waitFor()
    assert.equal(await page.getByText(/The update could not be completed/).count(), 0)
    assert.equal(await page.evaluate(() => (window as any).failurePending), "other")
  } finally { await page.close() }
})

test("a failure recorded while windows reloaded is reported once after the reload", async () => {
  const page = await fixture("reloaded-failure")
  try {
    await page.getByText(/The update could not be completed/).waitFor()
    await page.evaluate(() => (window as any).fixture.observe())
    await page.waitForFunction(() => (window as any).calls.filter((c: any) => c.command === "take_desktop_update_failure").length === 2)
    assert.equal(await page.getByText(/The update could not be completed/).count(), 1)
    // A failure owned by another live window stays with it.
    await page.evaluate(() => (window as any).emitFailure("other"))
    assert.equal(await page.evaluate(() => (window as any).failurePending), "other")
    assert.equal(await page.getByText(/The update could not be completed/).count(), 1)
  } finally { await page.close() }
})
