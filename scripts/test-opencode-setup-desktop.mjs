// Windows release acceptance. All CLI commands and app launches use fresh synthetic
// profiles. CDP is discovered from the host's native dynamic instrumentation.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { chromium } from "playwright"
import { createServer } from "node:net"
import { boundedFixtureOperation } from "./fixtures/wsl-fixture-bounds.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

assert.equal(process.platform, "win32", "This fixture validates Windows desktop artifacts")
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = await mkdtemp(path.join(os.tmpdir(), "opencode", "codenomad-setup-desktop-"))
console.log(`Evidence: ${root}`)
const requested = process.argv[2] ?? "both"
const bootstrapCli = process.argv[3]
assert.ok(bootstrapCli && path.isAbsolute(bootstrapCli), "Pass host (both/electron/tauri) and absolute fixture CLI used only to configure an isolated service port")
const oldDaemon = process.argv.includes("--old-daemon")
const resumeFolder = process.argv.includes("--resume-folder")
const artifacts = {
  electron: path.join(workspace, "packages/electron-app/release/win-unpacked/CodeNomad.exe"),
  tauri: path.join(workspace, "packages/tauri-app/target/release/codenomad-tauri.exe"),
}
const results = []
async function until(fn, message, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await boundedFixtureOperation(fn, deadline, message); if (value) return value; await delay(200) }
  throw new Error(message)
}
async function findPort(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const name = path.join(directory, entry.name)
    if (entry.name === "DevToolsActivePort") return Number((await readFile(name, "utf8")).split(/\r?\n/)[0])
    if (entry.isDirectory()) { const port = await findPort(name); if (port) return port }
  }
}
for (const [host, executable] of Object.entries(artifacts)) {
  if (requested !== "both" && requested !== host) continue
  const profile = path.join(root, host)
  await mkdir(profile)
  const project = path.join(profile, "synthetic-project")
  await mkdir(project)
  const config = path.join(profile, "config.yaml")
  await writeFile(config, JSON.stringify({ server: { opencodeBinary: "opencode2" }, ui: { locale: "en" } }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(PATH|OPENCODE_.*|XDG_.*|CLI_.*|CODENOMAD_.*|NODE_.*|ELECTRON_.*|WEBVIEW2_.*|npm_.*|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)))
  Object.assign(env, {
    HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, "AppData/Roaming"), LOCALAPPDATA: path.join(profile, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(profile, "xdg-config"), XDG_DATA_HOME: path.join(profile, "xdg-data"),
    // Native service start intentionally strips XDG_STATE_HOME. Match its
    // synthetic HOME default so status/stop read the same isolated service record.
    XDG_STATE_HOME: path.join(profile, ".local/state"), XDG_CACHE_HOME: path.join(profile, "xdg-cache"),
    OPENCODE_TEST_HOME: profile, OPENCODE_CONFIG_DIR: path.join(profile, "opencode-config"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_DISABLE_MODELS_FETCH: "1",
    CLI_CONFIG: config, CLI_LOG_LEVEL: "debug", ELECTRON_ENABLE_LOGGING: "1", PATH: `${process.env.SystemRoot}\\System32`,
    npm_config_cache: path.join(profile, "npm-cache"), npm_config_userconfig: path.join(profile, "npmrc"),
  })
  for (const key of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG_DIR"]) await mkdir(env[key], { recursive: true })
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
  const servicePort = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const record = { host, executable, profile, servicePort, oldDaemon, sha256: createHash("sha256").update(await readFile(executable)).digest("hex"), checks: [] }
  const resources = path.join(path.dirname(executable), "resources")
  record.packagedFiles = {}
  for (const relative of ["server/dist/opencode-update/service.js", "server/dist/workspaces/opencode-cli-service.js", "server/dist/workspaces/native-service-registration.js", "server/public/index.html", "node/win32-x64/node.exe", "node/win32-x64/node_modules/npm/package.json"]) {
    record.packagedFiles[relative] = createHash("sha256").update(await readFile(path.join(resources, relative))).digest("hex")
  }
  record.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8", timeout: 10_000 }).trim()
  results.push(record)
  let output = "", browser, page, cli, child, stopped, childError
  const runCli = (binary, args, timeout = 30_000) => execFileSync(binary, args, { env, cwd: profile, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 }).trim()
  const statuses = []
  const observerErrors = [], observerTasks = new Set()
  const observe = observedPage => observedPage.on("response", response => {
    if (!response.url().endsWith("/api/opencode/update") && !response.url().endsWith("/api/opencode/service")) return
    const task = boundedFixtureOperation(async () => {
      statuses.push({ url: response.url(), method: response.request().method(), request: response.request().postDataJSON(), status: response.status(), body: await response.json() })
    }, Date.now() + 10_000, "setup response observation").catch(error => observerErrors.push(error.message)).finally(() => observerTasks.delete(task))
    observerTasks.add(task)
  })
  try {
    runCli(bootstrapCli, ["service", "set", "port", String(servicePort)])
    if (oldDaemon) {
      runCli(bootstrapCli, ["service", "start"], 60_000)
      record.oldVersion = runCli(bootstrapCli, ["--version"])
      record.oldService = runCli(bootstrapCli, ["service", "status"])
      assert.equal(record.oldService, `http://127.0.0.1:${servicePort}`)
    }
    child = spawn(executable, resumeFolder ? ["--folder", project] : [], { cwd: profile, env, stdio: ["ignore", "pipe", "pipe"] })
    // Native-parent-started services may inherit a pipe after the desktop exits.
    // Observe process exit separately; the isolated service is stopped below.
    stopped = new Promise(resolve => child.once("exit", resolve))
    child.on("error", error => { childError = error })
    const append = chunk => { output = (output + chunk).slice(-4 * 1024 * 1024) }
    child.stdout.on("data", append); child.stderr.on("data", append)
    const port = await until(async () => {
      if (childError) throw childError
      if (child.exitCode !== null) throw new Error(`${host} exited ${child.exitCode}: ${output}`)
      return await findPort(profile)
    }, `${host}: dynamic CDP not found`)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 })
    page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => /^https?:\/\/127\.0\.0\.1/.test(candidate.url())), `${host}: application page not found`)
    page.setDefaultTimeout(90_000)
    observe(page)
    for (const context of browser.contexts()) context.on("page", observe)
    await page.getByRole("dialog").waitFor()
    await page.getByText(/^(OpenCode is not installed\.|OpenCode n’est pas installé\.)$/).waitFor()
    await page.screenshot({ path: path.join(profile, "01-missing.png") })
    record.checks.push("real missing setup screen, minimum 2.0.11")
    await page.getByRole("button", { name: /^(Close|Fermer)$/ }).click()
    await page.locator('[role="status"] button').click()
    await page.getByRole("dialog").waitFor()
    record.checks.push("dismiss and persistent recovery reentry")
    await page.getByRole("button", { name: /^(Install and start OpenCode|Installer et démarrer OpenCode)$/ }).click()
    await until(async () => {
      const versions = await readdir(path.join(profile, ".local/share/codenomad/opencode/selected")).catch(() => [])
      if (!versions.length) return false
      cli = path.join(profile, ".local/share/codenomad/opencode", versions[0], "node_modules/@opencode/cli/bin/opencode.exe")
      return cli
    }, `${host}: bundled npm install failed`, 300_000)
    record.checks.push("bundled Node/npm installed real CLI with system Node and opencode absent from PATH")
    if (oldDaemon) {
      const restart = page.getByRole("button", { name: /^(Restart shared service|Redémarrer le service partagé)$/ })
      await until(async () => await restart.isVisible() || statuses.some(item => item.url.endsWith("/api/opencode/service") && item.method === "POST"), "Old daemon recovery did not settle")
      assert.ok(await restart.isVisible(), "Old running daemon was bypassed: service activation occurred before explicit restart")
      await page.screenshot({ path: path.join(profile, "02-explicit-restart.png") })
      assert.ok(!statuses.some(item => item.url.endsWith("/api/opencode/service") && item.method === "POST"), "install must not restart the old daemon")
      record.checks.push("old running daemon detected after install, restart deferred for explicit action")
      await restart.click()
    }
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 120_000 })
    await page.screenshot({ path: path.join(profile, "02-installed-connected.png") })
    record.cliVersion = runCli(cli, ["--version"])
    record.service = runCli(cli, ["service", "status"])
    record.checks.push("native-parent service activation, supported daemon admission, setup closes")
    if (resumeFolder) {
      record.workspaces = await until(async () => {
        const data = await page.evaluate(async () => (await fetch("/api/workspaces", { signal: AbortSignal.timeout(10_000) })).json())
        return JSON.stringify(data).toLowerCase().includes("synthetic-project") && data
      }, "Pending folder did not resume")
      await page.screenshot({ path: path.join(profile, "03-folder-resumed.png") })
      record.checks.push("pending native --folder intent resumed after setup")
    } else {
      assert.ok(!statuses.some(item => item.request?.reload), "configuration reload must never happen automatically")
      await page.getByRole("button", { name: "OpenCode", exact: true }).click()
      const preferences = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes("preferences")), "Native preferences page did not open")
      preferences.setDefaultTimeout(90_000)
      const reload = preferences.getByRole("button", { name: /^(Reload OpenCode configuration|Recharger la configuration OpenCode)$/ })
      await reload.waitFor()
      await preferences.screenshot({ path: path.join(profile, "03-reload-warning.png") })
      const [response] = await Promise.all([
        preferences.waitForResponse(response => response.url().endsWith("/api/opencode/service") && response.request().postDataJSON()?.reload === true, { timeout: 60_000 }),
        reload.click(),
      ])
      assert.equal(response.status(), 200)
      record.checks.push("native preferences explicit configuration reload, warning visible, authenticated reload succeeds; no automatic reload")
    }
    await boundedFixtureOperation(() => Promise.all(observerTasks), Date.now() + 12_000, "response observers")
    assert.deepEqual(observerErrors, [])
    record.pass = true
  } catch (error) {
    record.error = error.stack
    if (page) {
      await page.screenshot({ path: path.join(profile, "failure.png"), timeout: 5_000 }).catch(() => {})
      record.body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")
    }
    console.error(`${host}: ${error.message}`)
  } finally {
    const cleanupErrors = []
    if (browser) await boundedFixtureOperation(() => browser.close(), Date.now() + 5_000, "CDP cleanup").catch(error => cleanupErrors.push(error.message))
    // Kill only the exact fixture PID and its descendants, never installed hosts.
    if (child?.pid && child.exitCode === null) {
      try { execFileSync(path.join(process.env.SystemRoot, "System32/taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { stdio: "pipe", timeout: 10_000 }) }
      // taskkill can report a child that exited during its tree walk. The
      // bounded exit check below determines whether our desktop actually exited.
      catch (error) { record.taskkillNotice = error.message }
      await stopFixtureChild(child, stopped).catch(error => cleanupErrors.push(error.message))
    }
    try { record.cleanup = runCli(cli ?? bootstrapCli, ["service", "stop"]) } catch (error) { cleanupErrors.push(error.message) }
    child?.stdout?.destroy(); child?.stderr?.destroy()
    await boundedFixtureOperation(() => Promise.all(observerTasks), Date.now() + 12_000, "final response observers").catch(error => observerErrors.push(error.message))
    if (cleanupErrors.length || observerErrors.length) { record.pass = false; record.cleanupErrors = cleanupErrors; record.observerErrors = observerErrors }
    await writeFile(path.join(profile, "host.log"), output)
    await writeFile(path.join(profile, "setup-responses.json"), JSON.stringify(statuses, null, 2))
    await writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2))
  }
}
console.log(JSON.stringify(results, null, 2))
assert.ok(results.length && results.every(result => result.pass), `Desktop acceptance failed; evidence: ${root}`)
