// Native file dialog smoke on isolated hosts with the real source SessionView.
// No OpenCode daemon is needed: the UI fixture supplies deterministic native data.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { chromium, _electron } from "playwright"
import { startDeviceUploadFixture } from "../packages/ui/tests/browser/fixtures/device-upload-server.mjs"

assert.equal(process.platform, "win32")
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = await mkdtemp(path.join(os.tmpdir(), "opencode", "attachment-picker-desktop-"))
console.log(`Evidence: ${root}`)
const { server, url } = await startDeviceUploadFixture()
async function findPort(directory) {
  for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, item.name)
    if (item.name === "DevToolsActivePort") return Number((await readFile(file, "utf8")).split(/\r?\n/)[0])
    if (item.isDirectory()) { const port = await findPort(file); if (port) return port }
  }
}
async function until(fn) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(200) }
  throw new Error("Fixture startup timed out")
}
async function dialog(pid, file) {
  const args = ["-NoProfile", "-File", path.join(workspace, "scripts/fixtures/attachment-picker-windows.ps1"), "-OwnerPid", String(pid), ...(file ? ["-FilePath", file] : ["-Cancel"])]
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
    let output = ""
    child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(output)))
  })
}
const results = []
try {
  for (const host of process.argv[2] ? [process.argv[2]] : ["tauri", "electron"]) {
    const profile = path.join(root, host)
    await mkdir(profile)
    for (const folder of ["Desktop", "Documents", "Downloads"]) await mkdir(path.join(profile, folder))
    const sample = path.join(profile, "device-not-in-project.txt")
    await writeFile(sample, "native picker bytes")
    let app, browser, child, page, output = ""
    try {
      let pid
      if (host === "electron") {
        const env = { ...process.env, CODENOMAD_TEST_PROFILE: profile, CODENOMAD_TEST_URL: url }
        delete env.ELECTRON_RUN_AS_NODE
        app = await _electron.launch({ executablePath: createRequire(import.meta.url)("electron"),
          args: [path.join(workspace, "scripts/fixtures/attachment-picker-electron.cjs")], env })
        page = await app.firstWindow(); pid = app.process().pid
      } else {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          !/^(PATH|OPENCODE_.*|XDG_.*|CLI_.*|CODENOMAD_.*|NODE_.*|ELECTRON_.*|WEBVIEW2_.*|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)))
        Object.assign(env, { HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, "AppData", "Roaming"), LOCALAPPDATA: path.join(profile, "AppData", "Local"),
          XDG_CONFIG_HOME: path.join(profile, "config"), XDG_DATA_HOME: path.join(profile, "data"), XDG_STATE_HOME: path.join(profile, "state"),
          XDG_CACHE_HOME: path.join(profile, "cache"), OPENCODE_CONFIG_DIR: path.join(profile, "opencode"),
          OPENCODE_TEST_HOME: profile, CLI_CONFIG: path.join(profile, "config.yaml"), PATH: `${process.env.SystemRoot}\\System32` })
        for (const key of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG_DIR"]) await mkdir(env[key], { recursive: true })
        await writeFile(env.CLI_CONFIG, JSON.stringify({ server: { opencodeBinary: path.join(profile, "missing.exe") } }))
        child = spawn(process.env.CODENOMAD_FIXTURE_TAURI || path.join(workspace, "packages/tauri-app/target/release/codenomad-tauri.exe"), [], { cwd: profile, env, stdio: ["ignore", "pipe", "pipe"] })
        child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
        pid = child.pid
        // Rust's Windows known-folder lookup can retain the real local-data root
        // despite synthetic HOME. Discover only this unique config's native scope.
        const suffix = createHash("sha256").update(`dev-v2\0${env.CLI_CONFIG.replaceAll("/", "\\").toLowerCase()}`).digest("hex").slice(0, 16)
        const nativeScope = path.join(process.env.LOCALAPPDATA, "ai.neuralnomads.codenomad.client-v2", "scopes", `dev-v2-${suffix}`)
        const nativeFallback = path.join(os.homedir(), "ai.neuralnomads.codenomad.client-v2", "scopes", `dev-v2-${suffix}`)
        const port = await until(async () => await findPort(profile) || await findPort(nativeScope) || await findPort(nativeFallback))
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
        page = await until(() => browser.contexts().flatMap(context => context.pages()).find(p => /^https?:/.test(p.url())))
        console.log(`${host}: connected to native scope`)
        // Keep the host's permitted origin. Serve the source fixture through a
        // deterministic route rather than asking Tauri to navigate externally.
        const origin = new URL(page.url()).origin
        await page.route(`${origin}/**`, async route => {
          try {
            const request = new URL(route.request().url())
            const pathname = request.pathname === "/" ? "/device-upload-fixture" : request.pathname
            const response = await page.request.get(`${new URL(url).origin}${pathname}${request.search}`, { timeout: 20_000 })
            await route.fulfill({ response })
          } catch { await route.abort().catch(() => {}) }
        })
        await page.goto(`${origin}/device-upload-fixture`, { timeout: 30_000 })
      }
      page.setDefaultTimeout(20_000)
      page.on("pageerror", error => console.error(`${host} renderer: ${error.message}`))
      await page.waitForFunction(() => Boolean(window.fixture))
      console.log(`${host}: real SessionView ready`)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Page.setInterceptFileChooserDialog", { enabled: false })
      // Do not subscribe to Playwright's filechooser event: that would intercept
      // the OS dialog. Drive the actual owned Windows picker using UIAutomation.
      for (const selection of [sample, undefined, sample]) {
        console.log(`${host}: ${selection ? "select" : "cancel"} native picker`)
        await page.locator(".prompt-actions-menu-trigger").click()
        const [native] = await Promise.all([dialog(pid, selection), page.getByRole("menuitem", { name: "Attach file…", exact: true }).click()])
        console.log(`${host}: ${native.trim()}`)
        await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA")
        if (selection) {
          await page.waitForFunction(() => window.fixture.attachments().length === 1)
          const attachment = await page.evaluate(() => window.fixture.attachments()[0])
          assert.equal(attachment.url, `data:text/plain;base64,${Buffer.from("native picker bytes").toString("base64")}`)
          await page.screenshot({ path: path.join(profile, "attached.png") })
          await page.getByRole("button", { name: "Remove attachment", exact: true }).click()
        } else assert.deepEqual(await page.evaluate(() => window.fixture.attachments()), [])
      }
      results.push({ host, pass: true })
    } catch (error) {
      if (page) {
        console.error(await page.evaluate(() => ({ active: document.activeElement?.outerHTML, attachments: window.fixture?.attachments(), inputs: document.querySelectorAll('input[type="file"]').length })))
        await page.screenshot({ path: path.join(profile, "failure.png") }).catch(() => {})
      }
      throw error
    } finally {
      await app?.close()
      await browser?.close()
      if (child?.pid && child.exitCode === null) {
        try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "pipe", timeout: 10_000 }) } catch {}
      }
      await writeFile(path.join(profile, "host.log"), output)
    }
  }
} finally {
  await server.close()
  await writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2))
}
