import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "remote-control-fixture", configureServer(s) { s.middlewares.use("/fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/remote-control-settings.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] },
    // The middleware HTML is invisible to Vite's scanner; prepare the real entry before navigation deadlines.
    optimizeDeps: { entries: ["tests/browser/fixtures/remote-control-settings.tsx"], exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  await server.transformRequest("/tests/browser/fixtures/remote-control-settings.tsx")
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("after a failed resume, paired devices stay listed and Stop forgets the choice", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(`${url}?scenario=failed-resume`)
    await page.getByText("Relay connection failed", { exact: true }).waitFor()
    await page.getByText("Android · Firefox", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Start Remote Control" }).waitFor()
    const stop = page.getByRole("button", { name: "Stop Remote Control" })
    await stop.click()
    await page.getByText("Remote Control is off", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as unknown as { stops: number }).stops), 1)
    assert.equal(await stop.count(), 0)
    await page.getByText("Android · Firefox", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the host switches web previews for paired devices; paired devices only see the host's setting", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(`${url}?scenario=connected`)
    const previews = page.getByRole("switch", { name: "Web previews" })
    await previews.waitFor()
    assert.equal(await previews.isChecked(), true)
    await previews.click()
    await page.waitForFunction(() => !(document.querySelector('[role="switch"][aria-label="Web previews"]') as HTMLInputElement).checked)
    await previews.click()
    await page.waitForFunction(() => (document.querySelector('[role="switch"][aria-label="Web previews"]') as HTMLInputElement).checked)
    assert.deepEqual(await page.evaluate(() => (window as unknown as { previewChanges: boolean[] }).previewChanges), [false, true])

    await page.goto(`${url}?scenario=remote`)
    await page.getByText("Ready for remote connections", { exact: true }).waitFor()
    assert.equal(await page.getByRole("switch", { name: "Web previews" }).count(), 0)
  } finally { await page.close() }
})

test("a backend that did not resume offers no Stop that would clear the owner's choice", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(`${url}?scenario=skipped`)
    await page.getByText("Remote Control is off", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Start Remote Control" }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Stop Remote Control" }).count(), 0)
  } finally { await page.close() }
})

test("a pairing link survives a reconnect and disappears once Remote Control stops", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  const setState = (state: string) => page.evaluate((value) => (window as unknown as { setRemoteState: (state: string) => void }).setRemoteState(value), state)
  try {
    await page.goto(`${url}?scenario=connected`)
    await page.getByRole("button", { name: "Create new pairing link" }).click()
    const link = page.getByText("https://codenomad-fixture.tunnel.test/remote-pair#fixture-code", { exact: true })
    await link.waitFor()
    await setState("reconnecting")
    await page.getByRole("button", { name: "Refresh" }).click()
    await page.getByText("Reconnecting…", { exact: true }).waitFor()
    assert.equal(await link.isVisible(), true)
    await setState("stopped")
    await page.getByRole("button", { name: "Refresh" }).click()
    await link.waitFor({ state: "detached" })
  } finally { await page.close() }
})

test("a resuming tunnel updates by itself until it can create pairing links", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(`${url}?scenario=resuming`)
    await page.getByText("Connecting to the relay…", { exact: true }).waitFor()
    const newLink = page.getByRole("button", { name: "Create new pairing link" })
    assert.equal(await newLink.isDisabled(), true)
    await page.getByText("Ready for remote connections", { exact: true }).waitFor({ timeout: 15_000 })
    assert.equal(await newLink.isEnabled(), true)
    // Polling stops once connected.
    const reads = await page.evaluate(() => (window as unknown as { statusReads: () => number }).statusReads())
    await page.waitForTimeout(4_000)
    assert.equal(await page.evaluate(() => (window as unknown as { statusReads: () => number }).statusReads()), reads)
  } finally { await page.close() }
})
