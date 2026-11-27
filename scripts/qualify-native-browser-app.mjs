// Real app + backend + native parent, with a private OpenCode daemon and a deterministic provider:
// the model opens the conversation through codenomad.inspect/act, then calls OpenCode's own
// `tools.browser.*` through Code Mode, served by CodeNomad's session preview.
// Usage: node scripts/qualify-native-browser-app.mjs <app-executable | electron-dev> <opencode-executable> <output-directory>
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fixtureChildPid, spawnFixtureChild as spawn } from "./native-fixture-guards.mjs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile, chmod, readdir } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { tsImport } from "tsx/esm/api"
import Fastify from "fastify"
import staticFiles from "@fastify/static"

const [appPath, cli, output] = process.argv.slice(2)
const dev = appPath === "electron-dev"
if (!(dev || path.isAbsolute(appPath ?? "")) || ![cli, output].every(value => value && path.isAbsolute(value))) {
  throw Error("Usage: node scripts/qualify-native-browser-app.mjs <app-executable | electron-dev> <opencode-executable> <output-directory>")
}
const repo = fileURLToPath(new URL("..", import.meta.url)), root = path.join(output, "private"), project = path.join(root, "project")
await mkdir(project, { recursive: true })
const run = randomUUID().slice(0, 8), password = `p7-${randomUUID()}`, title = `Native browser qualification ${run}`
const { stopWindowsProcessTree } = await tsImport("../packages/server/src/process-tree.ts", import.meta.url)
let desired, issued, providerError, app, appStarted, ui, vite, viteStarted, daemon, daemonOutput = "", appOutput = "", viteOutput = ""
const evidence = []

const fixtureHtml = await readFile(new URL("../packages/tauri-app/tests/browser-parent/app.html", import.meta.url), "utf8")
const fixture = createServer((req, res) => {
  if (req.url === "/download") {
    res.setHeader("Content-Disposition", `attachment; filename="p7-${run}.txt"`)
    res.end(`native-download-${run}`)
  } else if (req.url === "/api/count") {
    res.setHeader("Content-Type", "application/json")
    res.setHeader("Set-Cookie", `p7=${run}`)
    res.end(JSON.stringify({ saved: true }))
  } else if (req.url === "/frames") {
    // A cross-site frame (localhost against 127.0.0.1) runs out of process; it and a worker start paused by diagnostics.
    res.setHeader("Content-Type", "text/html")
    res.end(`<title>Frames</title><output id="frame">Frame waiting</output> <output id="worker">Worker waiting</output>
<iframe src="http://localhost:${fixture.address().port}/child"></iframe><script>
addEventListener("message", event => { if (event.data === "child-ready") document.querySelector("#frame").textContent = "Frame loaded" })
new Worker("/worker.js").onmessage = () => { document.querySelector("#worker").textContent = "Worker ran" }</script>`)
  } else if (req.url === "/child") {
    res.setHeader("Content-Type", "text/html")
    res.end(`<script>console.warn("frame warning ${run}");fetch("/frame-api").then(response => response.text()).then(() => parent.postMessage("child-ready", "*"))</script>`)
  } else if (req.url === "/frame-api") {
    res.setHeader("Content-Type", "application/json")
    res.end("{}")
  } else if (req.url === "/worker.js") {
    res.setHeader("Content-Type", "text/javascript")
    res.end("postMessage('ran')")
  } else if (req.url === "/oauth") {
    res.setHeader("Content-Type", "text/html")
    res.end("<title>OAuth fixture</title><script>opener.postMessage('oauth-complete',location.origin);setTimeout(()=>close(),300)</script>")
  } else if (req.url === "/followed") {
    res.setHeader("Content-Type", "text/html")
    res.end("<title>Followed</title><h1>Link followed</h1>")
  } else { res.setHeader("Content-Type", "text/html"); res.end(fixtureHtml) }
})
const provider = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw), catalog = (body.tools || []).map(tool => tool.function?.name)
    const call = desired && catalog.includes(desired.name) ? desired : undefined
    if (call) { desired = undefined; issued = true }
    if (!body.stream) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: run, choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] })); return }
    res.setHeader("Content-Type", "text/event-stream")
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: run, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    chunk({ role: "assistant" })
    if (call) chunk({ tool_calls: [{ index: 0, id: `p7-${evidence.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] })
    else chunk({ content: "Done" })
    chunk({}, call ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n")
  } catch (error) { providerError = error; res.destroy(error) }
})
await Promise.all([fixture, provider].map(server => new Promise(done => server.listen(0, "127.0.0.1", done))))

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|CODENOMAD_)/.test(key)))
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".config"),
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1" })
await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
await writeFile(path.join(env.OPENCODE_CONFIG_DIR, "opencode.json"), "{}")
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", permissions: [{ action: "*", resource: "*", effect: "allow" }],
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture" }, models: { fixture: {} } } } })

async function until(check, timeout = 60000, label = "condition") {
  const end = Date.now() + timeout
  do { if (providerError) throw providerError; const value = await check(); if (value) return value; await delay(200) } while (Date.now() < end)
  throw Error(`Qualification ${label} timed out`)
}
/** The ref of the first non-text outline line naming `label` (exactly when quoted). */
function ref(content, label, exact = true) {
  const line = content.split("\n").find(line => line.includes(exact ? `"${label}"` : label) && !line.trimStart().startsWith("- text ") && /\[[^\]\s]+\]/.test(line))
  assert.ok(line, `Missing ${label}: ${content}`)
  return /\[([^\]\s]+)\]/.exec(line)[1]
}

try {
  daemon = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
  daemon.stdout.on("data", chunk => { daemonOutput += chunk }); daemon.stderr.on("data", chunk => { daemonOutput += chunk })
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(daemonOutput), 30000, "daemon")
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
  const session = await client.session.create({ location: { directory: project }, title })

  let uiUrl
  if (dev) {
    // The UI from source, served by Vite as in development.
    const vitePort = 20000 + Math.floor(Math.random() * 20000)
    viteStarted = new Date()
    vite = spawn(process.execPath, [path.join(repo, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
      { cwd: path.join(repo, "packages/ui"), env: process.env, windowsHide: true })
    vite.stdout.on("data", chunk => { viteOutput += chunk }); vite.stderr.on("data", chunk => { viteOutput += chunk })
    await until(() => viteOutput.replace(/\x1b\[[0-9;]*m/g, "").includes(`127.0.0.1:${vitePort}`), 180000, "vite")
    uiUrl = `http://127.0.0.1:${vitePort}/`
  } else {
    ui = Fastify()
    await ui.register(staticFiles, { root: path.join(repo, "packages/tauri-app/src-tauri/resources/server/public") })
    ui.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"))
    await ui.listen({ host: "127.0.0.1", port: 0 })
    uiUrl = `http://127.0.0.1:${ui.server.address().port}`
  }
  const config = path.join(root, "config.yaml")
  await writeFile(config, JSON.stringify({ server: { opencodeBinary: wrapper }, preferences: { lastUsedBinary: wrapper, locale: "en" }, opencodeBinaries: [{ path: wrapper, lastUsed: Date.now() }] }))
  const appEnv = { ...process.env, CODENOMAD_PROFILE: `p7-${run}`, CLI_CONFIG: config, VITE_DEV_SERVER_URL: uiUrl, ...(dev ? { NODE_ENV: "development" } : {}) }
  delete appEnv.ELECTRON_RUN_AS_NODE
  const electronApp = path.join(repo, "packages/electron-app")
  const [command, args, cwd] = dev ? [createRequire(import.meta.url)("electron"), [electronApp, project], electronApp] : [appPath, [project], path.dirname(appPath)]
  appStarted = new Date()
  app = spawn(command, args, { cwd, env: appEnv, windowsHide: false })
  app.stdout.on("data", chunk => { appOutput += chunk }); app.stderr.on("data", chunk => { appOutput += chunk })
  await until(async () => {
    if (app.exitCode !== null) throw Error(`App exited ${app.exitCode}: ${appOutput.slice(-4000)}`)
    return (await client.plugin.list({ location: { directory: project } })).data.some(plugin => plugin.id === "codenomad.automation" && plugin.state.status === "active")
  }, 180000, "app backend")

  async function call(name, args, label = name) {
    issued = false; desired = { name, args }
    await client.session.prompt({ sessionID: session.id, text: `Qualification step ${evidence.length + 1}: ${label}.` })
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(120000) })
    assert.ok(issued, `The model was offered ${name}`)
    const messages = await client.message.list({ sessionID: session.id, limit: 200, order: "asc" })
    const tool = messages.data.flatMap(message => message.type === "assistant" ? message.content : [])
      .filter(part => part.type === "tool" && [name, name.replace("_", ".")].includes(part.name)).at(-1)
    const text = tool?.state.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? ""
    evidence.push({ label, name, args, status: tool?.state.status, text })
    await writeFile(path.join(output, "tool-results.json"), JSON.stringify(evidence, null, 2))
    assert.equal(tool?.state.status, "completed", text)
    console.log(`PASS ${label}`)
    return text
  }
  const step = async (label, code) => JSON.parse(await call("execute", { code }, label))

  // The conversation is opened from the session list as a person does; its view then holds the browser.
  // The session list can still be loading when the backend connects.
  const outline = await until(async () => {
    const text = await call("codenomad_inspect", { query: title }, "inspect session list")
    return text.split("\n").some(line => line.includes(title) && /\[[^\]\s]+\]/.test(line)) && text
  }, 120000, "session list")
  await call("codenomad_act", { action: "click", ref: ref(outline, title, false) }, "open conversation")
  await until(async () => (await client.session.get({ sessionID: session.id })).permissions?.some(rule => rule.action === "browser" && rule.effect === "allow"), 120000, "browser attachment")
  console.log("PASS attached")

  const url = `http://127.0.0.1:${fixture.address().port}/`
  const opened = await step("open and snapshot", `const tab = await tools.browser.tabs.open({ url: ${JSON.stringify(url)} }); const snap = await tools.browser.snapshot({ tabID: tab.id }); return { tab, content: snap.content }`)
  const tabID = JSON.stringify(opened.tab.id), content = opened.content
  const at = label => JSON.stringify(ref(content, label))
  const act = await step("page actions", `const tabID = ${tabID};
await tools.browser.click({ tabID, ref: ${at("Increment")} });
await tools.browser.fill({ tabID, ref: ${at("Name")}, text: "Native parity" });
// press has no ref: the key goes to the focused field.
await tools.browser.click({ tabID, ref: ${at("Name")} });
await tools.browser.press({ tabID, key: "Enter" });
// Plan writes the same status as the key handler, so Enter is read first.
const waits = [];
for (const text of ["Count 1", "Pressed Enter"]) waits.push((await tools.browser.wait({ tabID, text, timeout: 5000 })).met);
await tools.browser.select({ tabID, ref: ${at("Plan")}, values: ["Pro"] });
await tools.browser.hover({ tabID, ref: ${at("Hover target")} });
await tools.browser.drag({ tabID, from: ${at("Drag source")}, to: ${at("Drop target")} });
await tools.browser.scroll({ tabID, deltaY: 150 });
for (const text of ["Plan Pro", "Hovered", "Dragged"]) waits.push((await tools.browser.wait({ tabID, text, timeout: 5000 })).met);
const found = (await tools.browser.find({ tabID, text: "Native parity" })).content.includes("Native parity");
let refused, copyRefused;
try { await tools.browser.evaluate({ tabID, script: "document.title" }) } catch (error) { refused = String(error?.message ?? error) }
try { await tools.browser.press({ tabID, key: "Control+C" }) } catch (error) { copyRefused = String(error?.message ?? error) }
let pickerRefused;
try { await tools.browser.click({ tabID, ref: ${at("Upload")} }) } catch (error) { pickerRefused = String(error?.message ?? error) }
// A load state names the load condition; a bare timeout is a pause.
const loaded = (await tools.browser.wait({ tabID, state: "load", timeout: 5000 })).met;
await tools.browser.click({ tabID, ref: ${at("OAuth popup")} });
const oauth = (await tools.browser.wait({ tabID, text: "OAuth complete", timeout: 10000 })).met;
await tools.browser.click({ tabID, ref: ${at("Download fixture")} });
return { waits, found, refused, copyRefused, pickerRefused, loaded, oauth }`)
  assert.deepEqual(act.waits, [true, true, true, true, true])
  assert.equal(act.found, true)
  assert.match(act.refused ?? "", /not available in the CodeNomad browser/)
  assert.match(act.copyRefused ?? "", /clipboard or context-menu shortcuts/)
  assert.match(act.pickerRefused ?? "", /native file picker/)
  assert.equal(act.loaded, true, "wait for load")
  assert.equal(act.oauth, true, "OAuth opener/postMessage")
  const downloads = process.platform === "linux"
    ? execFileSync("xdg-user-dir", ["DOWNLOAD"], { encoding: "utf8" }).trim()
    : path.join(os.homedir(), "Downloads")
  const download = await until(async () => {
    const name = (await readdir(downloads)).find(name => name.includes(`p7-${run}.txt`))
    return name && await readFile(path.join(downloads, name), "utf8").catch(() => "") === `native-download-${run}` ? name : undefined
  }, 60000, "download")
  if (!process.env.P7_SKIP_NATIVE_DIALOG) {
    await step("native dialog", `await tools.browser.click({ tabID: ${tabID}, ref: ${at("Native dialog")} }); return {}`)
    await delay(1500)
    if (process.platform === "darwin") execFileSync("python3", [new URL("fixtures/accept-owned-browser-dialog.py", import.meta.url).pathname, String(app.pid)])
    else if (process.platform === "linux") {
      const windows = execFileSync("xdotool", ["search", "--onlyvisible", "--pid", String(app.pid)], { encoding: "utf8" }).trim().split("\n")
      execFileSync("xdotool", ["windowactivate", "--sync", windows.at(-1)])
      execFileSync("xdotool", ["key", "Return"])
    } else {
      execFileSync("pwsh", ["-NoProfile", "-File", fileURLToPath(new URL("fixtures/accept-owned-browser-dialog.ps1", import.meta.url)), "-AppProcessId", String(await fixtureChildPid(app))], { encoding: "utf8", windowsHide: true, timeout: 20000 })
    }
    const accepted = await step("dialog accepted", `return { met: (await tools.browser.wait({ tabID: ${tabID}, text: "Dialog accepted", timeout: 10000 })).met }`)
    assert.equal(accepted.met, true)
  }
  // WebKit previews (macOS and Linux Tauri) refuse diagnostics: there the qualification checks that refusal.
  const support = await step("diagnostics support", `try { await tools.browser.console({ tabID: ${tabID} }); return { supported: true } }
catch (error) { return { supported: false, message: String(error?.message ?? error) } }`)
  if (!support.supported) {
    assert.ok(!dev && process.platform !== "win32" && /WebKit previews/.test(support.message), JSON.stringify(support))
  } else {
    // Increment logged a warning and posted its count: OpenCode's console and network tools read them back.
    const diagnostics = await step("console and network", `const tabID = ${tabID};
const logged = await tools.browser.console({ tabID, level: "warning" });
const listed = await tools.browser.network.list({ tabID, urlContains: "/api/count" });
const got = listed.requests[0] && await tools.browser.network.get({ tabID, id: listed.requests[0].id, includeBody: true });
return { warnings: logged.messages.map(entry => entry.text), requests: listed.requests.map(item => [item.method, item.statusCode, item.state]),
    requestBody: got?.requestBody, responseBody: got?.responseBody,
    cookie: got?.responseHeaders.find(header => header.name === "set-cookie")?.value }`)
    assert.ok(diagnostics.warnings.includes("Count is 1"), JSON.stringify(diagnostics))
    assert.deepEqual(diagnostics.requests, [["POST", 200, "completed"]])
    assert.deepEqual(diagnostics.requestBody, { state: "text", text: "{\"count\":1}", truncated: false })
    assert.deepEqual(diagnostics.responseBody, { state: "text", text: "{\"saved\":true}", truncated: false })
    assert.equal(diagnostics.cookie, "<redacted>")
    // Out-of-process frames and workers start paused: they must run, and the frame's own startup is captured.
    const frames = await step("frames and workers", `const tabID = ${tabID};
await tools.browser.navigate({ tabID, url: ${JSON.stringify(`http://127.0.0.1:${fixture.address().port}/frames`)} });
const waits = [];
for (const text of ["Frame loaded", "Worker ran"]) waits.push((await tools.browser.wait({ tabID, text, timeout: 10000 })).met);
// The page has its body; the network service reports the request finished a moment later.
let listed;
for (let attempt = 0; attempt < 20; attempt++) {
  listed = await tools.browser.network.list({ tabID, urlContains: "/frame-api" });
  if (listed.requests.length && listed.requests.every(item => item.state !== "pending")) break;
  await tools.browser.wait({ tabID, delayMs: 100 });
}
const logged = await tools.browser.console({ tabID, level: "warning" });
return { waits, requests: listed.requests.map(item => [item.method, item.statusCode, item.state]), warnings: logged.messages.map(entry => entry.text) }`)
    assert.deepEqual(frames.waits, [true, true], JSON.stringify(frames))
    assert.deepEqual(frames.requests, [["GET", 200, "completed"]], JSON.stringify(frames))
    assert.ok(frames.warnings.includes(`frame warning ${run}`), JSON.stringify(frames))
  }
  // The clicks above ran on a page scrolled by a wheel step; these aim far below the fold, then leave the page.
  const reopened = await step("reopen and snapshot", `const tabID = ${tabID};
await tools.browser.navigate({ tabID, url: ${JSON.stringify(url)} });
return { content: (await tools.browser.snapshot({ tabID })).content }`)
  const below = label => JSON.stringify(ref(reopened.content, label))
  const followed = await step("below the fold and a followed link", `const tabID = ${tabID};
await tools.browser.click({ tabID, ref: ${below("Below the fold")} });
const clicked = (await tools.browser.wait({ tabID, text: "Below clicked", timeout: 5000 })).met;
await tools.browser.click({ tabID, ref: ${below("Follow link")} });
return { clicked, arrived: (await tools.browser.wait({ tabID, text: "Link followed", timeout: 5000 })).met }`)
  assert.equal(followed.clicked, true, "a click on an element the page had to scroll to")
  assert.equal(followed.arrived, true, "a click that follows a link succeeds")
  const shot = await step("screenshot", `const shot = await tools.browser.screenshot({ tabID: ${tabID} }); return { files: shot.files }`)
  assert.equal(shot.files?.[0]?.mime, "image/png")
  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, run, sessionID: session.id, project, app: appPath,
    appSHA256: dev ? undefined : createHash("sha256").update(await readFile(appPath)).digest("hex"),
    steps: evidence.map(entry => entry.label), download, screenshot: shot.files[0].path, nativeDialog: !process.env.P7_SKIP_NATIVE_DIALOG }, null, 2))
  // The private daemon stops below; a pending shutdown read must not hold the run.
  await Promise.race([shared.shutdown(), delay(10000)])
} finally {
  if (process.platform === "win32") {
    for (const [child, started] of [[app, appStarted], [vite, viteStarted]]) {
      if (child?.pid && child.exitCode === null) await stopWindowsProcessTree(child.pid, started).catch(error => console.error("stop", error))
    }
  } else {
    app?.kill(); vite?.kill()
    for (const [, pid] of appOutput.matchAll(/spawned pid=(\d+)/g)) {
      try {
        const args = execFileSync("ps", ["-ww", "-p", pid, "-o", "command="], { encoding: "utf8" })
        if (args.includes(`codenomad_session_${app.pid}_`)) process.kill(-Number(pid), "SIGTERM")
      } catch { /* The exact owned backend may already have stopped. */ }
    }
  }
  daemon?.kill()
  await writeFile(path.join(output, "app.log"), appOutput)
  await writeFile(path.join(output, "vite.log"), viteOutput)
  await writeFile(path.join(output, "opencode.log"), daemonOutput)
  await Promise.all([fixture, provider].map(server => new Promise(done => server.close(done))))
  await ui?.close()
}
console.log("PASS qualification")
// The shared service may keep handles open after its bounded shutdown.
process.exit(0)
