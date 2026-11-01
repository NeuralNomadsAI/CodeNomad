// No CodeNomad backend/profile, shared daemon or desktop instance is involved.
// Hosts the frame probe in the isolated Tauri fixture: WebView2 on Windows,
// WKWebView on macOS, WebKitGTK on Linux.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runProbe } from "./panel-extension-native-probe.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workspace = path.join(root, "packages/tauri-app")
const target = path.resolve(process.env.CARGO_TARGET_DIR || path.join(workspace, "target"))
const env = { ...process.env, CARGO_TARGET_DIR: target }
delete env.NODE_OPTIONS
delete env.CODENOMAD_NATIVE_PARENT
const build = spawnSync("cargo", ["build", "-p", "codenomad-panel-extension-fixture"], {
  cwd: workspace, env, encoding: "utf8", timeout: 1_800_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
})
assert.equal(build.error, undefined, String(build.error))
assert.equal(build.status, 0, build.stdout + build.stderr)
const apiVersion = process.argv.includes("--api4") ? 4 : process.argv.includes("--api3") ? 3 : process.argv.includes("--api2") ? 2 : 1
const executable = path.join(target, "debug", `codenomad-panel-extension-fixture${process.platform === "win32" ? ".exe" : ""}`)
const engine = { win32: "WebView2", darwin: "WKWebView", linux: "WebKitGTK" }[process.platform] ?? process.platform
const summary = await runProbe({ host: `Tauri/${engine}`, apiVersion, launch: async url => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "opencode-panel-native-"))
  try {
    // One host per mode, alive long enough for the frame report and the leak grace period.
    const child = spawn(executable, [url, profile, "10"], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let output = ""
    child.stdout.on("data", chunk => { output += chunk })
    child.stderr.on("data", chunk => { output += chunk })
    const timeout = setTimeout(() => child.kill(), 60_000)
    const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve) }).finally(() => clearTimeout(timeout))
    assert.equal(status, 0, output)
    return output
  } finally {
    // WebView2 releases its child-process lock shortly after the host exits.
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
} })
console.log(JSON.stringify(summary, null, 2))
