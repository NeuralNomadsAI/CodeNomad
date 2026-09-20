import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import path from "node:path"
let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "setup-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/opencode-setup.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("missing and required-update flows share a screen; stale daemon restart is explicit", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let installed = false, running = false, restarts = 0, installs = 0
  await page.route("**/api/**", async route => {
    const request = route.request()
    if (request.url().endsWith("/api/opencode/update") && request.method() === "POST") {
      installed = true; installs++
      return route.fulfill({ json: { success: true, version: "2.0.11" } })
    }
    if (request.url().endsWith("/api/opencode/service")) {
      assert.equal(request.postDataJSON().restart, true)
      restarts++; running = true
    }
    return route.fulfill({ json: { state: installed ? "ready" : "missing", currentVersion: installed ? "2.0.11" : null,
      latestVersion: "2.0.11", minimumVersion: "2.0.11", binaryPath: "opencode2", target: "host",
      canUpgrade: !installed, updateAvailable: !installed, daemonVersion: running ? "2.0.11" : "2.0.10",
      serviceState: installed ? running ? "ready" : "restart_required" : undefined, canRestart: installed && !running } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByRole("button", { name: "Install and start OpenCode" }).click()
    await page.getByRole("button", { name: "Restart shared service" }).waitFor()
    if (process.env.CODENOMAD_SETUP_CAPTURE) await page.screenshot({ path: path.join(process.env.CODENOMAD_SETUP_CAPTURE, "opencode-setup-restart.png") })
    assert.equal(installs, 1)
    assert.equal(restarts, 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.resumed()), 0)
    await page.getByText(/Restart interrupts active work/).waitFor()
    await page.getByRole("button", { name: "Restart shared service" }).click()
    await page.waitForFunction(() => (window as any).fixture.resumed() === 1)
    assert.equal(restarts, 1)
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.deepEqual(errors, [])
  } catch (error) { console.error(errors, await page.locator("body").innerText()); throw error }
  finally { await page.close() }
})

test("closing required-update screen leaves a persistent recovery entry", async () => {
  const page = await browser.newPage()
  await page.route("**/api/**", route => route.fulfill({ json: { state: "update_required", currentVersion: "2.0.10",
    latestVersion: "2.0.11", minimumVersion: "2.0.11", binaryPath: "opencode2", target: "host", canUpgrade: true, canRestart: false } }))
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.getByRole("dialog").waitFor()
    if (process.env.CODENOMAD_SETUP_CAPTURE) await page.screenshot({ path: path.join(process.env.CODENOMAD_SETUP_CAPTURE, "opencode-setup-required.png") })
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "OpenCode setup required" }).click()
    await page.getByRole("dialog").waitFor()
    assert.equal(await page.getByText("2.0.10", { exact: true }).count(), 1)
  } catch (error) { console.error(await page.locator("body").innerText()); throw error }
  finally { await page.close() }
})

test("optional updates stay non-blocking and a failed install remains recoverable", async () => {
  const page = await browser.newPage()
  let attempts = 0, starts = 0
  await page.route("**/api/**", async route => {
    const request = route.request()
    if (request.url().endsWith("/api/opencode/update") && request.method() === "POST") {
      attempts++
      return route.fulfill({ status: 500, json: { error: "upgrade_failed" } })
    }
    if (request.url().endsWith("/api/opencode/service")) starts++
    return route.fulfill({ json: { state: "ready", currentVersion: "2.0.11", latestVersion: "2.0.12",
      minimumVersion: "2.0.11", binaryPath: "opencode2", target: "host", canUpgrade: true, canRestart: false,
      serviceState: "ready", daemonVersion: "2.0.11" } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.getByRole("dialog").count(), 0)
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByRole("button", { name: "Update to OpenCode 2.0.12" }).click()
    await page.locator(".settings-error-message").waitFor()
    assert.equal(starts, 0)
    assert.equal(attempts, 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.resumed()), 0)
    await page.getByRole("button", { name: "Update to OpenCode 2.0.12" }).click()
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'))
    assert.equal(attempts, 2)
  } finally { await page.close() }
})

test("unsupported proxy calls open recovery once without replaying mutations", async () => {
  const page = await browser.newPage()
  let blocked = false, prompts = 0
  await page.route("**/api/**", route => {
    if (route.request().url().includes("/instance/api/")) {
      prompts++; blocked = true
      return route.fulfill({ status: 426, json: { code: "opencode_update_required" } })
    }
    return route.fulfill({ json: { state: "ready", currentVersion: "2.0.11", latestVersion: "2.0.11",
      minimumVersion: "2.0.11", binaryPath: "opencode2", target: "host", canUpgrade: false,
      serviceState: blocked ? "restart_required" : "ready", canRestart: blocked, daemonVersion: blocked ? "2.0.10" : "2.0.11" } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.evaluate(() => (window as any).fixture.unsupported()), 426)
    await page.getByRole("button", { name: "Restart shared service" }).waitFor()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).fixture.unsupported()), 426)
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(prompts, 2, "each intentional call occurs once; recovery never retries a prompt")
  } finally { await page.close() }
})

test("optional install reconnects without restarting and leaves explicit activation available", async () => {
  const page = await browser.newPage()
  let installed = false, restarts = 0, connects = 0
  await page.route("**/api/**", async route => {
    const request = route.request()
    if (request.url().endsWith("/api/opencode/update") && request.method() === "POST") {
      installed = true
      return route.fulfill({ json: { success: true, version: "2.0.12" } })
    }
    if (request.url().endsWith("/api/opencode/service")) {
      if (request.postDataJSON().restart) restarts++
      else connects++
    }
    return route.fulfill({ json: { state: "ready", currentVersion: installed ? "2.0.12" : "2.0.11",
      latestVersion: "2.0.12", minimumVersion: "2.0.11", binaryPath: "opencode2", target: "host",
      canUpgrade: !installed, updateAvailable: !installed, daemonVersion: restarts ? "2.0.12" : "2.0.11",
      serviceState: installed && !restarts ? "restart_available" : "ready", canRestart: installed && !restarts } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByRole("button", { name: "Update to OpenCode 2.0.12" }).click()
    await page.waitForFunction(() => (window as any).fixture.resumed() === 1)
    assert.equal(connects, 1, "rebind backend authority while retaining the supported daemon")
    assert.equal(restarts, 0)
    await page.getByRole("button", { name: "Restart shared service" }).waitFor()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    assert.equal(await page.getByRole("button", { name: "OpenCode setup required" }).count(), 0)
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByRole("button", { name: "Restart shared service" }).click()
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    assert.equal(restarts, 1)
  } finally { await page.close() }
})

test("configuration reload is an informed explicit action and never runs on setup reads", async () => {
  const page = await browser.newPage()
  let reloads = 0
  await page.route("**/api/**", route => {
    if (route.request().url().endsWith("/api/opencode/service")) {
      assert.deepEqual(route.request().postDataJSON(), { reload: true })
      reloads++
    }
    return route.fulfill({ json: { state: "ready", currentVersion: "2.0.11", latestVersion: "2.0.11",
      minimumVersion: "2.0.11", binaryPath: "opencode2", target: "wsl", canUpgrade: false,
      serviceState: "ready", canRestart: false, canReload: true, daemonVersion: "2.0.11" } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByText(/cancels pending permissions and forms/).waitFor()
    assert.equal(reloads, 0)
    await page.getByRole("button", { name: "Reload OpenCode configuration" }).click()
    await page.waitForFunction(() => (window as any).fixture.resumed() === 1)
    assert.equal(reloads, 1)
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

test("activation failure after installation retains the installed version and retries connection", async () => {
  const page = await browser.newPage()
  let installed = false, connected = false, installations = 0, attempts = 0
  await page.route("**/api/**", route => {
    const request = route.request()
    if (request.url().endsWith("/api/opencode/update") && request.method() === "POST") {
      installed = true; installations++
      return route.fulfill({ json: { success: true, version: "2.0.11" } })
    }
    if (request.url().endsWith("/api/opencode/service")) {
      attempts++
      if (attempts === 1) return route.fulfill({ status: 502, json: { error: "service_activation_failed" } })
      connected = true
    }
    return route.fulfill({ json: { state: installed ? "ready" : "missing", currentVersion: installed ? "2.0.11" : null,
      latestVersion: "2.0.11", minimumVersion: "2.0.11", binaryPath: "opencode2", target: "host",
      canUpgrade: !installed, canRestart: false, serviceState: connected ? "ready" : "stopped" } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.getByRole("button", { name: "Install and start OpenCode" }).click()
    await page.getByText("The OpenCode action could not be completed. Check the current status above and retry.").waitFor()
    assert.equal(await page.getByRole("button", { name: "Install and start OpenCode" }).count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.resumed()), 0)
    await page.getByRole("button", { name: "Connect and continue" }).click()
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    assert.equal(installations, 1)
    assert.equal(attempts, 2)
  } finally { await page.close() }
})
