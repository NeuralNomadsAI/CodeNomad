// Hosts the frame probe in real Electron with the real preload and the webPreferences
// of createWindow (read from main.ts). No CodeNomad backend, profile or daemon is involved.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runProbe } from "./panel-extension-native-probe.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const electronApp = path.join(root, "packages/electron-app")
const require = createRequire(path.join(electronApp, "package.json"))
const preload = path.join(electronApp, "electron/preload/index.cjs")
const windowId = "panel-extension-probe"

function topLevelEntries(body) {
  const entries = []
  let current = "", depth = 0, quote = null
  for (const char of body) {
    if (quote) { if (char === quote) quote = null }
    else if (char === '"' || char === "'" || char === "`") quote = char
    else if ("([{".includes(char)) depth++
    else if (")]}".includes(char)) depth--
    if (char === "," && depth === 0 && !quote) { entries.push(current.trim()); current = "" } else current += char
  }
  return current.trim() ? [...entries, current.trim()] : entries
}

// Evaluates createWindow's webPreferences entry by entry; any entry this test cannot
// reproduce exactly fails instead of being dropped.
function createWindowPreferences(source) {
  const start = source.indexOf("const createWindow = (")
  assert.notEqual(start, -1, "createWindow is no longer found in main.ts")
  const open = source.indexOf("{", source.indexOf("webPreferences: {", start))
  assert.ok(open > start, "createWindow no longer declares webPreferences")
  let depth = 0, close = open
  for (; close < source.length; close++) {
    if (source[close] === "{") depth++
    else if (source[close] === "}" && --depth === 0) break
  }
  const preferences = {}
  for (const entry of topLevelEntries(source.slice(open + 1, close))) {
    if (entry === "...(saved ? { zoomFactor: saved.zoomFactor } : {})") continue // persisted zoom only
    const [, key, value] = /^(\w+):\s*([\s\S]+)$/.exec(entry) ?? []
    if (value === "true" || value === "false") preferences[key] = value === "true"
    else if (value === "!isMac") preferences[key] = process.platform !== "darwin"
    else if (key === "preload" && value === "getPreloadPath()") preferences.preload = preload
    else if (key === "additionalArguments" && /^\[[\s\S]*\]$/.test(value)) {
      preferences.additionalArguments = topLevelEntries(value.slice(1, -1)).map(item => {
        if (/^"[^"]*"$/.test(item)) return JSON.parse(item)
        assert.match(item, /^`[^`$]*\$\{windowId\}[^`$]*`$/, `Unrecognized createWindow additional argument: ${item}`)
        return item.slice(1, -1).replace("${windowId}", windowId)
      })
    } else assert.fail(`Unrecognized createWindow webPreferences entry: ${entry}`)
  }
  assert.equal(preferences.preload, preload, "createWindow must load the real preload")
  return preferences
}

const webPreferences = createWindowPreferences(await readFile(path.join(electronApp, "electron/main/main.ts"), "utf8"))
const channels = [...new Set([...(await readFile(preload, "utf8")).matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map(match => match[1]))]
assert.ok(channels.includes("cli:getStatus"), "The preload no longer exposes the positive control")
const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-panel-electron-"))
try {
  const entry = path.join(directory, "fixture.cjs")
  // Every preload invoke channel reports whether the main frame or a subframe sent it.
  await writeFile(entry, `const { app, BrowserWindow, ipcMain } = require("electron")
const config = JSON.parse(require("node:fs").readFileSync(process.argv[process.argv.indexOf("--probe-config") + 1], "utf8"))
process.on("uncaughtException", error => { console.error(error); app.exit(1) })
for (const channel of config.channels) ipcMain.handle(channel, event => {
  const main = event.sender.mainFrame, frame = event.senderFrame
  const fromMain = Boolean(frame) && frame.processId === main.processId && frame.routingId === main.routingId
  console.log(fromMain && channel === "cli:getStatus" ? "NATIVE:parent" : "NATIVE:" + (fromMain ? "parent-other:" : "child:") + channel)
  return null
})
void app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, webPreferences: config.webPreferences })
  void window.loadURL(config.url)
  setTimeout(() => app.exit(0), config.seconds * 1000)
})
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  // Some Linux test hosts disable unprivileged user namespaces; opt-in only.
  const sandboxArgs = process.platform === "linux" && process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : []
  const summary = await runProbe({ host: "Electron", apiVersion: 4, launch: async (url, mode) => {
    const config = path.join(directory, `${mode}.json`)
    await writeFile(config, JSON.stringify({ url, seconds: 8, channels, webPreferences }))
    const child = spawn(require("electron"), [entry, "--probe-config", config, `--user-data-dir=${path.join(directory, `profile-${mode}`)}`, ...sandboxArgs],
      { env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", chunk => { output += chunk })
    child.stderr.on("data", chunk => { output += chunk })
    const timeout = setTimeout(() => child.kill(), 60_000)
    const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve) }).finally(() => clearTimeout(timeout))
    assert.equal(status, 0, output)
    return output
  } })
  console.log(JSON.stringify({ webPreferences: { ...webPreferences, preload: path.relative(root, preload) }, ...summary }, null, 2))
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
