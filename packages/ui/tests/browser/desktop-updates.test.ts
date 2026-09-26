import assert from "node:assert/strict"
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

async function fixture(scenario: string, host = "tauri", context = "local"): Promise<Page> {
  const page = await browser.newPage()
  page.on("pageerror", error => console.error("updater fixture:", error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.addInitScript(({ scenario, host, context }) => {
    const w = window as any
    w.__name = (value: unknown) => value
    w.__CODENOMAD_RUNTIME_HOST__ = host
    w.__CODENOMAD_WINDOW_CONTEXT__ = context
    w.calls = []
    const callbacks = new Map<number, Function>()
    const listeners = new Map<string, number>()
    let sequence = 0
    w.__TAURI__ = {}
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: Function) => { callbacks.set(++sequence, callback); return sequence },
      invoke: async (command: string, args: any) => {
        w.calls.push({ command, args })
        if (command === "plugin:event|listen") { listeners.set(args.event, args.handler); return args.handler }
        if (command === "check_stable_update") {
          if (scenario === "check-error") throw new Error("unavailable endpoint")
          if (scenario === "current-after-check" && w.calls.filter((c: any) => c.command === command).length > 1) return { status: "current" }
          return scenario === "unsigned" ? { status: "unsupported" }
            : scenario === "current" ? { status: "current" } : { status: "available", version: "0.21.0" }
        }
        if (command === "install_stable_update") {
          if (scenario === "signature-error") throw new Error("invalid signature")
          await new Promise<void>(resolve => { w.finishDownload = resolve })
        }
      },
    }
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (event: string) => listeners.delete(event) }
    w.emitFailure = () => callbacks.get(listeners.get("desktop-update:failed")!)?.({ payload: null })
    w.open = (url: string) => { w.calls.push({ command: "web-open", args: { url } }); return {} }
  }, { scenario, host, context })
  await page.goto(url)
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
      assert.equal(calls.filter((c: any) => c.command === "install_stable_update").length, 0)
      assert.equal(calls.filter((c: any) => c.command === "check_stable_update").length, host === "tauri" && context === "local" ? 1 : 0)
    } finally { await page.close() }
  }
})

test("installation needs an explicit action; duplicate gestures and shutdown failure do not replay it", async () => {
  const page = await fixture("available")
  try {
    await page.getByRole("button", { name: "Check updates" }).click()
    await page.getByText(/CodeNomad 0.21.0 is available/).waitFor()
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "install_stable_update").length), 0)
    await page.getByRole("button", { name: "Install and restart" }).click()
    await page.getByText("Downloading and verifying the update…").waitFor()
    await page.getByRole("button", { name: "Install and restart" }).waitFor({ state: "hidden" })
    await page.evaluate(() => (window as any).fixture.check())
    await page.evaluate(() => (window as any).finishDownload())
    await page.getByText("Saving windows and installing the update…").waitFor()
    await page.evaluate(() => (window as any).emitFailure())
    await page.getByText(/The update could not be completed/).waitFor()
    const calls = await page.evaluate(() => (window as any).calls)
    assert.deepEqual(calls.filter((c: any) => c.command === "install_stable_update").map((c: any) => c.args), [{ version: "0.21.0" }])
    assert.equal(calls.filter((c: any) => c.command === "check_stable_update").length, 1)
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
      assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "install_stable_update").length), scenario === "signature-error" ? 1 : 0)
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
    assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "install_stable_update").length), 0)
  } finally { await page.close() }
})
