// Real packaged app + backend + native parent, with a private OpenCode daemon and
// deterministic provider producing ordinary codenomad.browser agent tool calls.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile, chmod, readdir } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"

const [appPath, cli, outputPath] = process.argv.slice(2)
if (![appPath, cli, outputPath].every(value => value && path.isAbsolute(value))) throw Error("Usage: node scripts/qualify-native-browser-app.mjs <app-executable> <opencode-executable> <output-directory>")
const output = outputPath, root = path.join(output, "private"), project = path.join(root, "project")
await mkdir(project, { recursive: true })
const run = randomUUID().slice(0, 8), password = `p7-${randomUUID()}`, started = Date.now()
let desired, issued, providerError, app, daemon, daemonOutput = "", appOutput = ""
const tools = [], evidence = []
const fixtureHtml = await readFile(new URL("../packages/tauri-app/tests/browser-parent/app.html", import.meta.url), "utf8")
const fixture = createServer((req, res) => {
  if (req.url === "/download") {
    res.setHeader("Content-Disposition", `attachment; filename="p7-${run}.txt"`)
    res.end(`native-download-${run}`)
  } else if (req.url === "/oauth") {
    res.setHeader("Content-Type", "text/html")
    res.end("<title>OAuth fixture</title><script>opener.postMessage('oauth-complete',location.origin);setTimeout(()=>close(),300)</script>")
  } else { res.setHeader("Content-Type", "text/html"); res.end(fixtureHtml) }
})
const provider = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw), catalog = (body.tools || []).map(tool => tool.function?.name)
    const command = catalog.includes("codenomad_browser") ? desired : undefined
    if (command) { desired = undefined; issued = true; tools.push(command) }
    if (!body.stream) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: run, choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] })); return }
    res.setHeader("Content-Type", "text/event-stream")
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: run, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    chunk({ role: "assistant" })
    if (command) chunk({ tool_calls: [{ index: 0, id: `p7-${tools.length}`, type: "function", function: { name: "codenomad_browser", arguments: JSON.stringify(command) } }] })
    else chunk({ content: "Done" })
    chunk({}, command ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n")
  } catch (error) { providerError = error; res.destroy(error) }
})
await Promise.all([fixture, provider].map(server => new Promise(done => server.listen(0, "127.0.0.1", done))))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|CODENOMAD_)/.test(key)))
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1" })
await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
await writeFile(path.join(env.OPENCODE_CONFIG_DIR, "opencode.json"), "{}")
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", permissions: [{ action: "*", resource: "*", effect: "allow" }],
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture" }, models: { fixture: {} } } } })
async function until(check, timeout = 60000) {
  const end = Date.now() + timeout
  do { if (providerError) throw providerError; const value = await check(); if (value) return value; await delay(150) } while (Date.now() < end)
  throw Error("Qualification condition timed out")
}
function strings(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(strings).join("\n")
  return value && typeof value === "object" ? Object.values(value).map(strings).join("\n") : ""
}
try {
  daemon = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
  daemon.stdout.on("data", chunk => { daemonOutput += chunk }); daemon.stderr.on("data", chunk => { daemonOutput += chunk })
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(daemonOutput))
  const baseUrl = daemonOutput.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  // The fixture CLI adapter pins lifecycle discovery to this retained private daemon.
  // All non-lifecycle commands run the real CLI under the same isolated environment.
  const wrapperModule = path.join(root, "cli.cjs"), wrapper = path.join(root, process.platform === "win32" ? "opencode.cmd" : "opencode")
  await writeFile(wrapperModule, `const {spawnSync}=require('node:child_process'); const a=process.argv.slice(2); if(a.join(' ')==='service status')console.log(${JSON.stringify(baseUrl)}); else if(a.join(' ')==='service get password')console.log(${JSON.stringify(password)}); else if(a[0]==='service'){console.error('Fixture lifecycle is externally owned');process.exit(1)}else {const r=spawnSync(${JSON.stringify(cli)},a,{env:${JSON.stringify(env)},stdio:'inherit',windowsHide:true});process.exit(r.status??1)}`)
  await writeFile(wrapper, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${wrapperModule}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${wrapperModule.replaceAll("'", "'\\''")}' "$@"\n`)
  if (process.platform !== "win32") await chmod(wrapper, 0o755)
  const { OpenCodeCliService } = await tsImport("../packages/server/src/workspaces/opencode-cli-service.ts", import.meta.url)
  const { OpenCodeSharedService } = await tsImport("../packages/server/src/workspaces/opencode-service.ts", import.meta.url)
  const lifecycle = new OpenCodeCliService({ label: "Private app qualification", timeoutMs: 10000, command: args => ({ command: cli, args, options: {} }) },
    { execFile: async (_file, args) => ({ stdout: args.join(" ") === "service get password" ? password : baseUrl, stderr: "" }) })
  const shared = new OpenCodeSharedService(), client = await shared.client({ kind: "lifecycle", identity: `p7-${run}`, lifecycle })
  const session = await client.session.create({ location: { directory: project }, title: "Native browser qualification" })
  const config = path.join(root, "config.yaml")
  await writeFile(config, JSON.stringify({ server: { opencodeBinary: wrapper }, preferences: { lastUsedBinary: wrapper, locale: "en" }, opencodeBinaries: [{ path: wrapper, lastUsed: Date.now() }] }))
  const appEnv = { ...process.env, CODENOMAD_PROFILE: `p7-${run}`, CLI_CONFIG: config }
  delete appEnv.VITE_DEV_SERVER_URL; delete appEnv.ELECTRON_RUN_AS_NODE
  app = spawn(appPath, [project], { cwd: path.dirname(appPath), env: appEnv, windowsHide: false })
  app.stdout.on("data", chunk => { appOutput += chunk }); app.stderr.on("data", chunk => { appOutput += chunk })
  await until(async () => {
    if (app.exitCode !== null) throw Error(`App exited ${app.exitCode}: ${appOutput.slice(-4000)}`)
    return (await client.plugin.list({ location: { directory: project } })).data.some(plugin => plugin.id === "codenomad.automation" && plugin.state.status === "active")
  }, 90000)
  async function call(command) {
    issued = false; desired = command
    await client.session.prompt({ sessionID: session.id, text: `Qualification step ${evidence.length + 1}. Use the browser tool.` })
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(95000) })
    assert.ok(issued, "Native model tool catalog must invoke codenomad.browser")
    const messages = await client.message.list({ sessionID: session.id, limit: 100, order: "asc" })
    const tool = messages.data.flatMap(message => message.type === "assistant" ? message.content : [])
      .filter(part => part.type === "tool" && part.name.includes("browser")).at(-1)
    assert.equal(tool?.state.status, "completed", JSON.stringify(tool?.state))
    const result = tool.state.content
    evidence.push({ command, toolID: tool.id, status: tool.state.status, content: result })
    await writeFile(path.join(output, "tool-results.json"), JSON.stringify(evidence, null, 2))
    console.log(`PASS ${command.action}`)
    return result
  }
  const url = `http://127.0.0.1:${fixture.address().port}/`
  await call({ action: "open", url })
  let snapshot = strings(await call({ action: "snapshot" }))
  const ref = label => {
    const line = snapshot.split("\n").find(line => line.includes(`"${label}"`))
    assert.ok(line, `Missing ${label}: ${snapshot}`)
    return /\[([^\]]+)\]/.exec(line)[1]
  }
  await call({ action: "click", ref: ref("Increment") })
  await call({ action: "type", ref: ref("Name"), text: "Native parity" })
  await call({ action: "select", ref: ref("Plan"), values: ["Pro"] })
  await call({ action: "press", ref: ref("Name"), key: "Enter" })
  await call({ action: "hover", ref: ref("Hover target") })
  await call({ action: "drag", ref: ref("Drag source"), to: ref("Drop target") })
  await call({ action: "scroll", ref: ref("Scroll box"), direction: "down", amount: 150 })
  for (const text of ["Count 1", "Pressed Enter", "Hovered", "Dragged", "Scrolled"]) await call({ action: "wait", text })
  await call({ action: "click", ref: ref("OAuth popup") })
  await call({ action: "wait", text: "OAuth complete" })
  await call({ action: "click", ref: ref("Download fixture") })
  const downloads = path.join(os.homedir(), "Downloads")
  const download = await until(async () => (await readdir(downloads)).find(name => name.includes(`p7-${run}.txt`)))
  assert.equal(await readFile(path.join(downloads, download), "utf8"), `native-download-${run}`)
  const dialog = call({ action: "click", ref: ref("Native dialog") })
  await delay(1500)
  if (process.platform === "darwin") execFileSync("osascript", ["-e", `tell application "System Events" to tell (first process whose unix id is ${app.pid}) to set frontmost to true`, "-e", 'tell application "System Events" to key code 36'])
  else if (process.platform === "linux") {
    const windows = execFileSync("xdotool", ["search", "--onlyvisible", "--pid", String(app.pid)], { encoding: "utf8" }).trim().split("\n")
    execFileSync("xdotool", ["windowactivate", "--sync", windows.at(-1)])
    execFileSync("xdotool", ["key", "Return"])
  } else {
    execFileSync("pwsh", ["-NoProfile", "-Command", `$w=New-Object -ComObject WScript.Shell; $w.AppActivate(${app.pid}) | Out-Null; Start-Sleep -Milliseconds 150; $w.SendKeys('{ENTER}')`], { windowsHide: true })
  }
  await dialog
  await call({ action: "wait", text: "Dialog accepted" })
  snapshot = strings(await call({ action: "snapshot" }))
  assert.match(snapshot, /Native parity/)
  const image = strings(await call({ action: "screenshot" }))
  const png = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(image)
  if (png) await writeFile(path.join(output, "browser.png"), Buffer.from(png[1], "base64"))
  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, run, sessionID: session.id, project, appPath,
    appSHA256: createHash("sha256").update(await readFile(appPath)).digest("hex"), tools: tools.map(command => command.action), download, screenshot: !!png }, null, 2))
  await shared.shutdown()
} finally {
  app?.kill(); daemon?.kill()
  await writeFile(path.join(output, "app.log"), appOutput)
  await writeFile(path.join(output, "opencode.log"), daemonOutput)
  await Promise.all([fixture, provider].map(server => new Promise(done => server.close(done))))
}
