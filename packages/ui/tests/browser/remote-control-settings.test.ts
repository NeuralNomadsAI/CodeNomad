import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, solid(), { name: "remote-control-fixture", configureServer(s) { s.middlewares.use("/fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/remote-control-settings.tsx"></script></body></html>'))
    }) } }], resolve: { dedupe: ["solid-js"] },
    // The middleware HTML is invisible to Vite's scanner; prepare the real entry before navigation deadlines.
    optimizeDeps: { entries: ["tests/browser/fixtures/remote-control-settings.tsx"], exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } }).catch(async error => { await cache.dispose(); throw error })
  shutdown.own(server)
  await server.listen()
  await server.transformRequest("/tests/browser/fixtures/remote-control-settings.tsx")
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close() })

test("after a failed resume, paired devices stay listed and Stop forgets the choice", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(`${url}?scenario=failed-resume`)
    await page.getByText("Connection failed", { exact: true }).waitFor()
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
    await previews.focus()
    await page.keyboard.press("Shift+Tab")
    await page.getByRole("tooltip").filter({ hasText: "Keep preview addresses private." }).waitFor()
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

test("a pending revocation stays visible and retryable after refreshing the device list", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await page.goto(`${url}?scenario=connected`)
    const device = page.locator(".remote-control-device")
    const revoke = device.getByRole("button", { name: "Revoke", exact: true })
    const pending = device.getByText("Revocation pending", { exact: true })
    await revoke.click()
    await pending.waitFor()
    const reads = await page.evaluate(() => (window as unknown as { statusReads: () => number }).statusReads())
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await page.waitForFunction(before => (window as unknown as { statusReads: () => number }).statusReads() > before
      && !document.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.disabled, reads)
    await pending.waitFor()
    await revoke.click()
    await device.waitFor({ state: "detached" })
    await page.getByText("No devices are paired yet.", { exact: true }).waitFor()
  } finally { await page.close() }
})

test("an administrator-disabled Remote Control offers no Start or previews, explains why and keeps devices revocable", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(`${url}?scenario=disabled`)
    await page.getByText("Disabled by administrator", { exact: true }).waitFor()
    assert.equal(await page.locator('.remote-control-status').getAttribute("data-state"), "disabled")
    const info = page.getByRole("link", { name: /CODENOMAD_REMOTE_CONTROL=disabled/ })
    await info.waitFor()
    for (const name of ["Start Remote Control", "Stop Remote Control", "Create new pairing link", "Create HTTPS pairing link"]) {
      assert.equal(await page.getByRole("button", { name }).count(), 0, name)
    }
    assert.equal(await page.getByRole("switch", { name: "Web previews" }).count(), 0)
    assert.equal(await page.getByText("Direct HTTPS pairing", { exact: true }).count(), 0)
    await page.getByText("Android · Firefox", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Revoke" }).waitFor()
    assert.deepEqual(errors, [])
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

test("direct HTTPS pairing works with the tunnel off until administrator policy disables it", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(`${url}?scenario=direct`)
    await page.getByText("Remote Control is off", { exact: true }).waitFor()
    await page.getByText("Direct HTTPS pairing", { exact: true }).waitFor()
    const create = page.getByRole("button", { name: "Create HTTPS pairing link" })
    await create.click()
    await page.getByText("https://code.example.test/remote-pair#fixture-code", { exact: true }).waitFor()
    await page.getByLabel("HTTPS address", { exact: true }).selectOption("https://ui.example.test:8443")
    await create.click()
    const link = page.getByText("https://ui.example.test:8443/remote-pair#fixture-code", { exact: true })
    await link.waitFor()
    assert.deepEqual(await page.evaluate(() => (window as unknown as { pairingOrigins: unknown[] }).pairingOrigins),
      ["https://code.example.test", "https://ui.example.test:8443"])
    // A direct link does not depend on the tunnel, so a refresh while it is off keeps it.
    const refresh = page.getByRole("button", { name: "Refresh" })
    await refresh.click()
    await refresh.and(page.locator(":enabled")).waitFor()
    assert.equal(await link.isVisible(), true)
    await page.getByText("HTTPS · https://code.example.test", { exact: true }).waitFor()
    assert.equal(await page.getByText("Remote Control", { exact: true }).count(), 2, "card title and the tunnel device's label")

    await page.evaluate(() => (window as unknown as { setRemoteState: (state: string) => void }).setRemoteState("disabled"))
    await refresh.click()
    await page.getByText("Disabled by administrator", { exact: true }).waitFor()
    await link.waitFor({ state: "detached" })
    assert.equal(await create.count(), 0)
    assert.equal(await page.getByRole("button", { name: "Revoke" }).count(), 2)

    await page.goto(`${url}?scenario=remote`)
    await page.getByText("Ready for remote connections", { exact: true }).waitFor()
    assert.equal(await page.getByText("Direct HTTPS pairing", { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a resuming tunnel updates by itself until it can create pairing links", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(`${url}?scenario=resuming`)
    await page.getByText("Connecting…", { exact: true }).waitFor()
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
