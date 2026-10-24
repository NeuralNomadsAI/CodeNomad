import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

const TUNNEL = "https://codenomad-fixture.device.opentunnel.test"
const LINK = `${TUNNEL}/remote-pair#single-use-code`
// A local Electron window: remote windows are opened through the native bridge, recorded here.
const HOST = `<script>window.__CODENOMAD_WINDOW_CONTEXT__ = "local"; window.__CODENOMAD_RUNTIME_HOST__ = "electron";
window.opened = []; window.electronAPI = { openRemoteWindow: async (payload) => { window.opened.push(payload) } }</script>`

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, solid(), { name: "remote-server-pairing-fixture", configureServer(s) { s.middlewares.use("/fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/fixture", `<html><body><div id="root"></div>${HOST}<script type="module" src="/tests/browser/fixtures/remote-server-pairing.tsx"></script></body></html>`))
    }) } }], resolve: { dedupe: ["solid-js"] },
    // The middleware HTML is invisible to Vite's scanner; prepare the real entry before navigation deadlines.
    optimizeDeps: { entries: ["tests/browser/fixtures/remote-server-pairing.tsx"], exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  await server.listen()
  await server.transformRequest("/tests/browser/fixtures/remote-server-pairing.tsx")
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close() })

async function submit(page: Page, address: string, button: "Save" | "Connect") {
  await page.getByLabel("Name").fill("Desk")
  await page.getByLabel("Server URL").fill(address)
  await page.getByRole("button", { name: button, exact: true }).click()
}

const opened = (page: Page) => page.evaluate(() => (window as unknown as { opened: Array<{ id: string; baseUrl: string; entryUrl?: string }> }).opened)

test("a pasted pairing link saves only the server and pairs in the window it opens", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.getByText("A server address, or a Remote Control pairing link created on that computer.", { exact: true }).waitFor()
    // Skipping TLS checks would later route Tauri through the incognito proxy store and lose the pairing.
    await page.getByLabel("Skip TLS verification for self-signed certificates.").check()
    // Save, not Connect: the single-use code would otherwise be lost.
    await submit(page, LINK, "Save")
    await page.waitForFunction(() => (window as unknown as { opened: unknown[] }).opened.length === 1)
    const [payload] = await opened(page)
    assert.equal(payload.baseUrl, TUNNEL)
    assert.equal(payload.entryUrl, LINK)
    assert.equal((payload as { skipTlsVerify?: boolean }).skipTlsVerify, false)
    assert.deepEqual(await page.evaluate(() => (window as unknown as { probes: string[] }).probes), [`${TUNNEL} skipTls=false`])
    const state = JSON.parse(await page.evaluate(() => (window as unknown as { uiState: () => string }).uiState()))
    assert.equal(JSON.stringify(state).includes("single-use-code"), false)
    assert.deepEqual(state.remoteServers.map((server: { baseUrl: string; skipTlsVerify: boolean }) => [server.baseUrl, server.skipTlsVerify]), [[TUNNEL, false]])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("pairing a saved server again reuses it instead of adding a duplicate", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(`${url}?scenario=saved`)
    await page.getByTestId("servers").getByText(`saved-tunnel ${TUNNEL}`).waitFor()
    await submit(page, LINK, "Connect")
    await page.waitForFunction(() => (window as unknown as { opened: unknown[] }).opened.length === 1)
    assert.equal((await opened(page))[0].id, "saved-tunnel")
    assert.equal(await page.getByTestId("servers").locator("li").count(), 1)
  } finally { await page.close() }
})

test("an ordinary address saved without Connect opens no window", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(url)
    await submit(page, "https://server.example.com", "Save")
    await page.getByTestId("servers").getByText("https://server.example.com").waitFor()
    assert.deepEqual(await opened(page), [])
  } finally { await page.close() }
})
