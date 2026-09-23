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
    cacheDir: "node_modules/.vite-opencode-setup",
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

test("missing installation and incompatible daemon expose different actions; restart is explicit", async () => {
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
      latestVersion: "2.0.11", minimumVersion: "2.0.7", recommendedVersion: "2.0.11", binaryPath: "opencode2", target: "host",
      canUpgrade: !installed, updateAvailable: !installed, daemonVersion: running ? "2.0.11" : "2.0.6",
      serviceState: installed ? running ? "ready" : "restart_required" : undefined, canRestart: installed && !running } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    const installBounds = await page.getByRole("button", { name: "Install and start OpenCode" }).boundingBox()
    const selectorBounds = await page.locator(".selector-input").boundingBox()
    assert.ok(installBounds && selectorBounds && installBounds.y < selectorBounds.y, "recovery presents diagnosis and installation before executable selection")
    if (process.env.CODENOMAD_SETUP_CAPTURE) await page.screenshot({ path: path.join(process.env.CODENOMAD_SETUP_CAPTURE, "opencode-setup-missing.png"), fullPage: true })
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

test("closing required-update screen leaves recovery clickable above a pending folder overlay", async () => {
  const page = await browser.newPage()
  await page.route("**/api/**", route => route.fulfill({ json: { state: "update_required", currentVersion: "2.0.6",
    latestVersion: "2.0.11", minimumVersion: "2.0.7", recommendedVersion: "2.0.11", binaryPath: "opencode2", target: "host", canUpgrade: true, canRestart: false } }))
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.getByRole("dialog").waitFor()
    await page.evaluate(() => {
      const overlay = document.createElement("div")
      overlay.className = "folder-loading-overlay"
      document.getElementById("root")!.append(overlay)
    })
    if (process.env.CODENOMAD_SETUP_CAPTURE) await page.screenshot({ path: path.join(process.env.CODENOMAD_SETUP_CAPTURE, "opencode-setup-required.png") })
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "OpenCode setup required" }).click()
    await page.getByRole("dialog").waitFor()
    assert.equal(await page.getByText("2.0.6", { exact: true }).count(), 1)
    assert.equal(await page.locator("details[open]").count(), 0)
    await page.getByText("Version details", { exact: true }).click()
    await page.getByText(/introduced the native step-start timestamp/).waitFor()
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
    return route.fulfill({ json: { state: "ready", currentVersion: "2.0.10", latestVersion: "2.0.11",
      minimumVersion: "2.0.7", recommendedVersion: "2.0.11", versionAssessment: "untested", binaryPath: "opencode2", target: "host", canUpgrade: true, canRestart: false,
      serviceState: "ready", daemonVersion: "2.0.10" } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.getByRole("dialog").count(), 0)
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByText(/OpenCode 2.0.10 has not been fully validated/).waitFor()
    if (process.env.CODENOMAD_SETUP_CAPTURE) await page.screenshot({ path: path.join(process.env.CODENOMAD_SETUP_CAPTURE, "opencode-setup-optional.png") })
    await page.getByRole("button", { name: "Update to OpenCode 2.0.11" }).click()
    await page.locator(".settings-error-message").waitFor()
    assert.equal(starts, 0)
    assert.equal(attempts, 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.resumed()), 0)
    await page.getByRole("button", { name: "Update to OpenCode 2.0.11" }).click()
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
      minimumVersion: "2.0.7", recommendedVersion: "2.0.11", binaryPath: "opencode2", target: "host", canUpgrade: false,
      serviceState: blocked ? "restart_required" : "ready", canRestart: blocked, daemonVersion: blocked ? "2.0.6" : "2.0.11" } })
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
      latestVersion: "2.0.12", minimumVersion: "2.0.7", recommendedVersion: "2.0.11", binaryPath: "opencode2", target: "host",
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
    await page.getByText(/You can keep using the running service and restart later/).waitFor()
    assert.equal(await page.getByText(/The running service needs updating/).count(), 0)
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
      minimumVersion: "2.0.7", recommendedVersion: "2.0.11", binaryPath: "opencode2", target: "wsl", canUpgrade: false,
      serviceState: "ready", canRestart: false, canReload: true, daemonVersion: "2.0.11" } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByText("Troubleshooting", { exact: true }).click()
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
      latestVersion: "2.0.11", minimumVersion: "2.0.7", recommendedVersion: "2.0.11", binaryPath: "opencode2", target: "host",
      canUpgrade: !installed, canRestart: false, serviceState: connected ? "ready" : "stopped" } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.getByRole("button", { name: "Install and start OpenCode" }).click()
    await page.getByText("The OpenCode action could not be completed. Check the current status above and retry.").waitFor()
    assert.equal(await page.getByRole("button", { name: "Install and start OpenCode" }).count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.resumed()), 0)
    await page.getByRole("button", { name: "Connect and continue" }).click()
    await page.getByText("OpenCode is connected.", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Connect and continue" }).count(), 0)
    assert.equal(installations, 1)
    assert.equal(attempts, 2)
  } finally { await page.close() }
})

test("settings keep executable selection and management inline, disclosures collapsed and logs last", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let reads = 0, starts = 0, reloads = 0
  let holdCheck = false, releaseCheck: (() => void) | undefined
  let releaseReload: (() => void) | undefined
  const status = { state: "ready", currentVersion: "2.0.11", latestVersion: "2.0.11", minimumVersion: "2.0.7",
    recommendedVersion: "2.0.11", binaryPath: "C:/fixture/opencode.exe", target: "host", canUpgrade: false,
    serviceState: "ready", daemonVersion: "2.0.11", canRestart: false, canReload: true }
  await page.route("**/api/**", async route => {
    const request = route.request()
    if (request.url().endsWith("/api/storage/binaries/validate")) return route.fulfill({ json: { valid: true, version: "2.0.11" } })
    if (request.url().endsWith("/api/opencode/service")) {
      if (request.postDataJSON().reload) {
        reloads++
        await new Promise<void>(resolve => { releaseReload = resolve })
      } else starts++
    } else if (request.url().includes("/api/opencode/")) {
      reads++
      if (holdCheck) await new Promise<void>(resolve => { releaseCheck = resolve })
    }
    return route.fulfill({ json: status })
  })
  try {
    await page.goto(`${url}?settings=1`, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.getByText("OpenCode is connected.", { exact: true }).waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await page.getByText("Minimum version", { exact: true }).isVisible(), false)
    assert.equal(await page.getByRole("button", { name: "Connect and continue" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Manage OpenCode…", exact: true }).count(), 0)
    const panel = page.locator(".opencode-setup-panel")
    assert.equal(await panel.getByRole("button", { name: "Reload OpenCode configuration", exact: true }).isVisible(), false)
    assert.equal(await page.locator("details").count(), 2)
    assert.equal(await page.locator("details[open]").count(), 0)
    const cards = page.locator("main .settings-section-stack > .settings-card")
    await cards.first().locator(".selector-input").waitFor()
    assert.equal(await cards.last().getByRole("heading", { name: "OpenCode Log Level", exact: true }).count(), 1, "log levels stay below all runtime controls and disclosures")
    await cards.last().locator(".selector-trigger").waitFor()
    if (process.env.CODENOMAD_SETUP_CAPTURE) await page.screenshot({ path: path.join(process.env.CODENOMAD_SETUP_CAPTURE, "opencode-settings-summary.png"), fullPage: true })
    await page.locator(".selector-input").fill("C:/fixture/custom-opencode.exe")
    await page.getByRole("button", { name: "Add", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.selectedBinary() === "C:/fixture/custom-opencode.exe")
    assert.equal(await page.getByRole("dialog").count(), 0)
    await page.getByText("Version details", { exact: true }).click()
    await page.getByText("Minimum recommended version", { exact: true }).waitFor()
    await page.getByText("Version details", { exact: true }).click()
    const before = reads
    holdCheck = true
    await panel.getByRole("button", { name: "Check status and updates" }).click()
    await panel.getByRole("button", { name: "Reading installed version..." }).waitFor()
    assert.equal(await panel.getByRole("button", { name: "Reading installed version..." }).isDisabled(), true)
    await page.waitForTimeout(30)
    holdCheck = false; releaseCheck?.()
    await panel.getByText("Status and update check complete.").waitFor()
    assert.ok(reads > before)
    await panel.getByText("Troubleshooting", { exact: true }).click()
    await panel.getByText(/cancels pending permissions and forms/).waitFor()
    await panel.getByRole("button", { name: "Reload OpenCode configuration", exact: true }).click()
    await panel.getByText("Reloading OpenCode configuration…", { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('[aria-busy="true"]'))
    // Wait for the request to reach the route before releasing its result.
    for (let count = 0; count < 100 && !releaseReload; count++) await page.waitForTimeout(10)
    assert.equal(reloads, 1)
    releaseReload?.()
    await panel.getByText("OpenCode configuration reloaded.").waitFor()
    assert.equal(starts, 0, "already-connected management does not start the service")
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.deepEqual(errors, [])
  } finally { releaseCheck?.(); releaseReload?.(); await page.close() }
})

test("French settings remain readable at narrow widths and failed checks recover visibly", async () => {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } })
  let fail = false
  await page.route("**/api/**", route => route.fulfill(fail
    ? { status: 503, json: { error: "unavailable" } }
    : { json: { state: "ready", currentVersion: "2.0.11", latestVersion: "2.0.11", minimumVersion: "2.0.7",
      recommendedVersion: "2.0.11", binaryPath: "C:/fixture/opencode.exe", target: "host", canUpgrade: false,
      serviceState: "ready", daemonVersion: "2.0.11", canReload: true } }))
  try {
    await page.goto(`${url}?settings=1&locale=fr&theme=dark`, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const panel = page.locator(".opencode-setup-panel")
    await panel.getByText("OpenCode est connecté.", { exact: true }).waitFor()
    await page.locator(".selector-input").waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(await page.locator("details[open]").count(), 0)
    if (process.env.CODENOMAD_SETUP_CAPTURE) await page.screenshot({ path: path.join(process.env.CODENOMAD_SETUP_CAPTURE, "opencode-settings-fr-narrow.png"), fullPage: true })
    assert.equal(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth), true)
    await panel.getByText("Détails des versions", { exact: true }).click()
    await panel.getByText("Version minimale recommandée", { exact: true }).waitFor()
    fail = true
    await panel.getByRole("button", { name: "Vérifier l’état et les mises à jour" }).click()
    await panel.getByRole("alert").waitFor()
    fail = false
    await panel.getByRole("button", { name: "Vérifier l’état et les mises à jour" }).click()
    await panel.getByText("Vérification de l’état et des mises à jour terminée.").waitFor()
    assert.equal(await panel.getByRole("alert").count(), 0)
  } finally { await page.close() }
})

test("continuing an already-connected recovery retries only the pending workspace", async () => {
  const page = await browser.newPage()
  let mutations = 0
  await page.route("**/api/**", route => {
    if (route.request().method() !== "GET" && /\/api\/opencode\/(service|update)$/.test(route.request().url())) mutations++
    return route.fulfill({ json: { state: "ready", currentVersion: "2.0.11", latestVersion: "2.0.11", minimumVersion: "2.0.7",
      recommendedVersion: "2.0.11", binaryPath: "opencode2", target: "host", canUpgrade: false, serviceState: "ready", daemonVersion: "2.0.11" } })
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByRole("button", { name: "Continue", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.resumed() === 1)
    assert.equal(mutations, 0)
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

test("settings expose and install an optional update directly, with retry feedback and no implicit restart", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  let installed = false, attempts = 0, starts = 0
  let releaseInstall: (() => void) | undefined
  await page.route("**/api/**", async route => {
    const request = route.request()
    if (request.url().endsWith("/api/opencode/update") && request.method() === "POST") {
      attempts++
      if (attempts === 1) return route.fulfill({ status: 502, json: { error: "upgrade_failed" } })
      await new Promise<void>(resolve => { releaseInstall = resolve })
      installed = true
      return route.fulfill({ json: { success: true, version: "2.0.11" } })
    }
    if (request.url().endsWith("/api/opencode/service")) {
      assert.equal(request.postDataJSON().restart, false)
      starts++
    }
    return route.fulfill({ json: { state: "ready", currentVersion: installed ? "2.0.11" : "2.0.9",
      latestVersion: "2.0.11", updateAvailable: !installed, canUpgrade: !installed,
      minimumVersion: "2.0.7", recommendedVersion: "2.0.11", versionAssessment: "tested",
      binaryPath: "opencode2", target: "host", daemonVersion: "2.0.9",
      serviceState: installed ? "restart_available" : "ready", canRestart: installed } })
  })
  try {
    await page.goto(`${url}?settings=1&locale=fr&theme=dark`, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.getByText("OpenCode 2.0.11 est disponible.", { exact: true }).waitFor()
    const update = page.getByRole("button", { name: "Mettre à jour vers OpenCode 2.0.11", exact: true })
    await update.waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    if (process.env.CODENOMAD_SETUP_CAPTURE) await page.screenshot({ path: path.join(process.env.CODENOMAD_SETUP_CAPTURE, "opencode-settings-update.png") })
    await update.click()
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    await update.click()
    await page.locator(".opencode-setup-panel button:disabled").filter({ hasText: "OpenCode" }).waitFor()
    for (let count = 0; count < 100 && !releaseInstall; count++) await page.waitForTimeout(10)
    assert.ok(releaseInstall)
    releaseInstall()
    await page.getByText("OpenCode est à jour.", { exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'))
    assert.equal(attempts, 2)
    assert.equal(starts, 1)
    assert.equal(await update.count(), 0)
    assert.equal(await page.getByRole("dialog").count(), 0)
    await page.getByText(/Vous pouvez continuer avec le service/).waitFor()
  } finally { releaseInstall?.(); await page.close() }
})

test("settings distinguish manual updates and failed registry checks from an up-to-date installation", async () => {
  const page = await browser.newPage()
  let offline = false
  await page.route("**/api/**", route => route.fulfill({ json: { state: "ready", currentVersion: "2.0.9",
    latestVersion: offline ? null : "2.0.11", updateAvailable: offline ? null : true, canUpgrade: false,
    checkError: offline ? "update_check_failed" : undefined, minimumVersion: "2.0.7", recommendedVersion: "2.0.11",
    binaryPath: "custom-opencode", target: "host", serviceState: "ready", daemonVersion: "2.0.9" } }))
  try {
    await page.goto(`${url}?settings=1`, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.getByText("OpenCode 2.0.11 is available.", { exact: true }).waitFor()
    await page.getByText(/Select a supported executable/).waitFor()
    assert.equal(await page.getByRole("button", { name: "Update to OpenCode 2.0.11" }).count(), 0)
    offline = true
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Could not read the installed OpenCode version.", { exact: true }).waitFor()
    assert.equal(await page.getByText("OpenCode is up to date.", { exact: true }).count(), 0)
    assert.equal(await page.getByText("OpenCode 2.0.11 is available.", { exact: true }).count(), 0)
  } finally { await page.close() }
})

test("user npm PATH repair is available at the current version and installation conflicts retain explicit retry", async () => {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } })
  let migrated = false, attempts = 0, connects = 0
  await page.route("**/api/**", route => {
    const request = route.request()
    if (request.url().endsWith("/api/storage/binaries/validate")) return route.fulfill({ json: { valid: true, version: "2.0.14" } })
    if (request.url().endsWith("/api/opencode/update") && request.method() === "POST") {
      if (++attempts === 1) return route.fulfill({ status: 409, json: { error: "installation_in_use" } })
      migrated = true
      return route.fulfill({ json: { success: true, version: "2.0.15" } })
    }
    if (request.url().endsWith("/api/opencode/service")) {
      assert.equal(request.postDataJSON().restart, false)
      connects++
    }
    return route.fulfill({ json: { state: "ready", currentVersion: "2.0.15", latestVersion: "2.0.15",
      updateAvailable: false, canUpgrade: !migrated, needsSharedInstallation: !migrated,
      installationSource: migrated ? "path" : "user", binaryPath: migrated ? "C:/Users/fixture/AppData/Roaming/npm/opencode2.cmd" : "C:/Users/fixture/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe",
      minimumVersion: "2.0.7", recommendedVersion: "2.0.11", versionAssessment: "untested", target: "host",
      serviceState: "ready", daemonVersion: "2.0.15", canRestart: false } })
  })
  try {
    await page.goto(`${url}?settings=1&locale=fr&theme=dark`, { waitUntil: "domcontentloaded", timeout: 90_000 })
    const install = page.getByRole("button", { name: "Installer pour l’utilisateur et configurer le PATH", exact: true })
    await install.waitFor()
    await page.getByText("Installation npm utilisateur trouvée hors du PATH actuel.", { exact: true }).waitFor()
    assert.match(await page.locator(".selector-badge-version").innerText(), /2\.0\.15/, "selector uses the current effective version rather than its old validation cache")
    assert.equal(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth), true)
    if (process.env.CODENOMAD_SETUP_CAPTURE) await page.screenshot({ path: path.join(process.env.CODENOMAD_SETUP_CAPTURE, "opencode-shared-path-repair-fr.png"), fullPage: true })
    await install.click()
    await page.getByRole("alert").filter({ hasText: /L’exécutable OpenCode est utilisé/ }).waitFor()
    assert.equal(connects, 0)
    await install.click()
    await page.getByText("Exécutable trouvé dans le PATH du serveur.", { exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'))
    assert.equal(connects, 1)
    assert.equal(await install.count(), 0)
    assert.equal(await page.getByRole("alert").count(), 0)
  } finally { await page.close() }
})
