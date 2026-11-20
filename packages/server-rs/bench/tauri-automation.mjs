// Real trial (Windows): `node tauri-automation.mjs <opencode.exe> <codenomad-tauri.exe>`. An isolated OpenCode
// daemon, then the given Tauri host with `CODENOMAD_SERVER_IMPL=rust` in the same private home and its own
// `CODENOMAD_PROFILE`, opened on a fixture project. The automation plugin's own tool code (inspect, act,
// screenshot, browser, restart) then runs against that host through the fixture's private bridge registry
// only, never the user's. Screenshots land in out/screenshots/tauri-automation/.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { fromDist, out, privateGit, repo, useBenchTemp, writeJson } from "./fixtures.mjs"
import { loopbackFetch } from "./memory.mjs"

const [exe, host] = process.argv.slice(2)
assert(path.isAbsolute(exe ?? "") && path.isAbsolute(host ?? ""), "usage: node tauri-automation.mjs <opencode.exe> <codenomad-tauri.exe>")
await useBenchTemp()
const { withProductRuntime, writeFixtureServiceRegistration } = await import(pathToFileURL(path.join(repo, "scripts/native-product-fixture.mjs")))
const { createDeveloperToolTransform, executeBrowserTool } = await fromDist("opencode/automation-plugin.js")
const { stopWindowsProcessTree } = await fromDist("process-tree.js")
const shots = path.join(out, "screenshots", "tauri-automation")
await mkdir(shots, { recursive: true })
const result = { host, steps: [] }
const record = (name, value) => { result.steps.push({ name, ...value }); console.log(name, JSON.stringify(value).slice(0, 300)) }

/** Processes running exactly `file`: this trial's host and its relaunches, never another CodeNomad. */
async function processes(file) {
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${file.replaceAll("'", "''")}' } | ForEach-Object { "{0},{1}" -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }`], { windowsHide: true })
  return stdout.trim().split(/\r?\n/).filter(Boolean).map(row => { const [pid, at] = row.split(","); return { pid: Number(pid), started: new Date(at) } })
}

const page = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html")
  res.end(`<!doctype html><title>Trial form</title><label>Name <input id="name"></label><button onclick="document.title='clicked '+document.getElementById('name').value">Send</button>`)
})
await new Promise(resolve => page.listen(0, "127.0.0.1", resolve))
const pageUrl = `http://127.0.0.1:${page.address().port}/`

try {
  await withProductRuntime(exe, async () => ({}), async ({ client, root, env, connection }) => {
    const project = path.join(root, "projects", "Trial Project")
    await privateGit(project, "tauri-trial")
    await writeFile(path.join(project, "README.md"), "Tauri automation trial\n")
    const info = await client.server.info()
    const serviceFile = await writeFixtureServiceRegistration(env, { url: connection.endpoint.url, pid: info.pid, version: info.version, password: connection.endpoint.auth.password })
    const registry = path.join(env.LOCALAPPDATA, "CodeNomad", "automation-bridges")
    assert(registry.startsWith(path.join(out, "tmp")), registry)
    const hostEnv = { ...env, CODENOMAD_SERVER_IMPL: "rust", CODENOMAD_PROFILE: "automation-trial", CNRS_OPENCODE_SERVICE_FILE: serviceFile }
    assert.equal((await processes(host)).length, 0, "no trial host is already running")
    const child = spawn(host, [project], { env: hostEnv, cwd: root, windowsHide: false, stdio: "ignore", detached: true })
    child.unref()
    try {
      // The plugin's discovery reads this registry only.
      process.env.LOCALAPPDATA = env.LOCALAPPDATA
      const nodeFetch = globalThis.fetch
      globalThis.fetch = (input, init) => /^http:\/\/127\.0\.0\.1:\d+\/api\/opencode-plugin\/automation$/.test(String(input)) ? loopbackFetch(String(input), init) : nodeFetch(input, init)
      const tools = {}
      createDeveloperToolTransform()({ add: tool => { tools[tool.name] = tool } })
      const session = await client.session.create({ location: { directory: project }, title: "automation trial" })
      const call = (name, input) => tools[name].execute(input, { sessionID: session.id })
      const text = value => typeof value.content === "string" ? value.content : value.content.find(part => part.type === "text")?.text
      let inspection
      for (const end = Date.now() + 120_000; !inspection; await delay(1_000)) {
        try { inspection = text(await call("inspect", {})) } catch (error) { if (Date.now() > end) throw error }
      }
      const registrations = (await readdir(registry)).filter(name => name.endsWith(".json"))
      const published = await Promise.all(registrations.map(async name => JSON.parse(await readFile(path.join(registry, name), "utf8"))))
      const hosts = await processes(host)
      record("target", { hostPids: hosts.map(p => p.pid), registrations: published.map(r => r.pid) })
      assert(hosts.length >= 1, "the trial host runs from its own build")
      const devtools = await readdir(env.LOCALAPPDATA, { recursive: true }).then(files => files.filter(f => f.endsWith("DevToolsActivePort")))
      assert.deepEqual(devtools, [], "no remote debugging port is opened")
      assert.match(inspection, /^CodeNomad window \S+ · workspace /)
      record("inspect", { head: inspection.split("\n").slice(0, 2), lines: inspection.split("\n").length, diagnostics: inspection.includes("Runtime diagnostics:") })
      const composer = /- textbox [^\n]*\[(e\d+)\]/.exec(inspection)?.[1]
      assert(composer, "a text field to type into")
      const typed = await call("act", { action: "type", ref: composer, text: "Automation trial" })
      record("act type", { result: text(typed) })
      assert.match(text(typed), /"value": "Automation trial"/)
      await writeFile(path.join(out, "tauri-inspection.txt"), inspection)
      // The session's own entry in the list: selecting it makes this conversation active for the preview.
      const button = /- button "(automation trial)" \[(e\d+)\]/.exec(inspection)
      assert(button, "a button to click")
      const clicked = await call("act", { action: "click", ref: button[2] })
      record("act click", { button: button[1], result: text(clicked) })
      const selected = text(await call("inspect", { query: "automation trial" }))
      record("inspect after click", { head: selected.split("\n")[0] })
      assert.match(selected.split("\n")[0], new RegExp(`conversation ${session.id}`))
      const shot = await call("screenshot", {})
      const image = shot.content.find(part => part.type === "file")
      assert.match(image.uri, /^data:image\/png;base64,/)
      await writeFile(path.join(shots, "window.png"), Buffer.from(image.uri.split(",")[1], "base64"))
      record("screenshot", { bytes: Buffer.from(image.uri.split(",")[1], "base64").length })
      // The UI creates the preview record with POST /api/previews, which the Rust server does not serve yet:
      // `browser` is checked up to that refusal, the in-host page engine by the Tauri crate's tests.
      const preview = await executeBrowserTool(session.id, { action: "open", url: pageUrl }).then(value => ({ opened: text(value) }), error => ({ error: error.message }))
      record("browser open", preview)
      if (preview.opened) {
        const snapshot = text(await executeBrowserTool(session.id, { action: "snapshot" }))
        record("browser snapshot", { snapshot: snapshot.split("\n").slice(0, 6) })
        const field = /- textbox "Name" \[(b\d+e\d+)\]/.exec(snapshot)?.[1], send = /- button "Send" \[(b\d+e\d+)\]/.exec(snapshot)?.[1]
        record("browser type", { result: text(await executeBrowserTool(session.id, { action: "type", ref: field, text: "Ada" })) })
        record("browser click", { result: text(await executeBrowserTool(session.id, { action: "click", ref: send })) })
      }
      const probe = await executeBrowserTool(session.id, { action: "snapshot" }).then(value => ({ snapshot: text(value) }), error => ({ error: error.message }))
      record("browser without preview", probe)
      const before = (await processes(host))[0]
      const restarted = text(await call("act", { action: "restart" }))
      const after = await processes(host)
      record("restart", { before: before.pid, after: after.map(p => p.pid), head: restarted.split("\n").slice(0, 2) })
      assert.match(restarted, /^CodeNomad window /)
      assert(after.every(p => p.pid !== before.pid), "a new host process")
      const again = await call("screenshot", {})
      await writeFile(path.join(shots, "after-restart.png"), Buffer.from(again.content.find(p => p.type === "file").uri.split(",")[1], "base64"))
      globalThis.fetch = nodeFetch
    } finally {
      for (const { pid, started } of await processes(host)) await stopWindowsProcessTree(pid, started).catch(error => console.error(error))
      await delay(1_000)
      for (const name of await readdir(registry).catch(() => [])) await rm(path.join(registry, name), { force: true })
    }
  })
} catch (error) {
  result.error = String(error.stack)
  console.error(result.error)
  process.exitCode = 1
} finally {
  page.close()
  await writeJson("tauri-automation.json", result)
  console.log(`tauri-automation: ${result.error ? "FAILED" : "passed"}`)
}
