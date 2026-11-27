// The OpenCode daemon lifecycle of both servers on their own isolated profile (home, XDG folders,
// daemon port under out/tmp): start on the first workspace, discovery after a backend restart,
// reconnection after a daemon restart, a conversation each time, then the refusals of a V1 CLI,
// malformed CLI output and a daemon below the minimum version. `node service.mjs <opencode executable>`
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import net from "node:net"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { assertOutsideAccount, assertPrivateOpenCodeExecutable, sanitizeBenchEnvPath } from "./private-profile.mjs"

const rawExe = process.argv[2]
assert(path.isAbsolute(rawExe ?? ""), "usage: node service.mjs <absolute opencode executable> (Windows)")
const exe = await assertPrivateOpenCodeExecutable(rawExe)
assert(process.platform === "win32", "usage: node service.mjs <absolute opencode executable> (Windows)")
const { spawnFixtureChild, stopFixtureChild, stopFixtureHandle } = await import("../../../scripts/native-fixture-guards.mjs")
const { out, privateGit, rustBinary, useBenchTemp, writeJson } = await import("./fixtures.mjs")
// This bench deliberately restarts the backend while keeping its daemon alive.
// One job owns the whole bench; per-backend jobs would invalidate that experiment.
if (!process.argv.includes("--owned-service-worker")) {
  const worker = spawnFixtureChild(process.execPath, [process.argv[1], exe, "--owned-service-worker"],
    { windowsHide: true, stdio: "inherit" })
  const closed = once(worker, "close")
  const stop = () => void stopFixtureChild(worker, closed).catch(error => console.error(error.message))
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const [code] = await closed
  process.exit(code ?? 1)
}
const bin = rustBinary()
await useBenchTemp()
const free = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const { port } = s.address(); await new Promise(r => s.close(r)); return port }
const listen = async handler => { const s = createServer(handler); await new Promise(r => s.listen(0, "127.0.0.1", r)); return s }
const provider = await listen(async (req, res) => {
  for await (const _ of req);
  res.setHeader("Content-Type", "text/event-stream")
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "FIXTURE_ANSWER" }, null], [{}, "stop"]])
    res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
  res.end("data: [DONE]\n\n")
})
// A daemon below the minimum: authenticated `server.info` only.
const old = await listen((req, res) => {
  const ok = req.headers.authorization === `Basic ${Buffer.from("opencode:fake-pass").toString("base64")}`
  res.writeHead(ok && req.url === "/api/info" ? 200 : ok ? 404 : 401, { "content-type": "application/json" })
  res.end(ok && req.url === "/api/info" ? JSON.stringify({ version: "2.2.0", pid: 1, urls: [] }) : "")
})
const INHERITED = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|LANG|TZ)$/i
const password = `bench-${Math.random().toString(36).slice(2)}`

async function profile(label) {
  const root = path.join(out, "tmp", "opencode", `service-${label}-${Date.now()}`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => INHERITED.test(k)))
  await sanitizeBenchEnvPath(env, { allowedRoot: root })
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: path.join(root, "AppData", "Roaming"), LOCALAPPDATA: path.join(root, "AppData", "Local"),
    ProgramData: path.join(root, "ProgramData"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_DATA_HOME: path.join(root, "xdg-data"), XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    npm_config_userconfig: path.join(root, ".npmrc"), npm_config_cache: path.join(root, "npm-cache"), GIT_CEILING_DIRECTORIES: root,
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "fixture/fixture", providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }, models: { fixture: {} } } } }),
    CODENOMAD_SERVER_PASSWORD: password, CNRS_SERVER_PASSWORD: password })
  for (const d of [env.APPDATA, env.LOCALAPPDATA, env.ProgramData, env.TEMP]) await mkdir(d, { recursive: true })
  const project = path.join(root, "projects", "proj")
  await privateGit(project, `service-${label}`)
  const cli = async (...args) => (await promisify(execFile)(exe, args, { env, windowsHide: true, timeout: 30000 })).stdout.trim()
  const state = await cli("debug", "paths", "state")
  assert(state.startsWith(root), `isolated state ${state}`)
  await cli("service", "set", "port", String(await free()))
  await cli("service", "set", "hostname", "127.0.0.1")
  assert.equal(await cli("service", "status"), "stopped")
  const pid = async () => JSON.parse(await readFile(path.join(state, "service.json"), "utf8").catch(() => "{}")).pid
  // CLIs answering from fixed lines: a V1 help, a multiline status, the old daemon above.
  const fake = async (name, lines) => {
    const file = path.join(root, `${name}.cmd`)
    await writeFile(file, `@echo off\r\n${lines.join("\r\n")}\r\nexit /b 3\r\n`)
    return file
  }
  const fakes = {
    v1: await fake("v1", ["echo Commands:", "echo   opencode run   Run", "exit /b 1"]),
    multiline: await fake("multiline", ['if "%1 %2"=="service status" (echo a& echo b& exit /b 0)']),
    old: await fake("old", [`if "%1 %2"=="service status" (echo http://127.0.0.1:${old.address().port}& exit /b 0)`,
      'if "%1 %2 %3"=="service get password" (echo fake-pass& exit /b 0)']),
  }
  return { label, root, env, project, cli, pid, fakes }
}

async function start(p, binary, logs) {
  const port = await free()
  const config = path.join(p.root, `ts-${port}.yaml`)
  await writeFile(config, `server:\n  opencodeBinary: '${binary}'\n`)
  await mkdir(path.join(p.root, "ui"), { recursive: true })
  await writeFile(path.join(p.root, "ui", "index.html"), "<!doctype html>")
  // TS: its --config file; Rust (positional): settings beside the identity's data folder.
  assertOutsideAccount(p.env, p.label === "ts" ? path.dirname(config) : path.join(p.root, "rust.data"))
  const child = p.label === "ts"
    ? spawn(process.execPath, [path.join(import.meta.dirname, "ts-server.mjs"), "--http", "true", "--http-port", String(port), "--https", "false",
      "--ui-no-update", "--ui-dir", path.join(p.root, "ui"), "--config", config, "--workspace-root", path.dirname(p.project)],
      { env: { ...p.env, CODENOMAD_REMOTE_CONTROL: "disabled" }, cwd: p.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(bin, [path.dirname(p.project), path.join(p.root, "rust.json"), String(port), binary],
      { env: { ...p.env, CNRS_FIXTURE_STDIN_STOP: "1" }, cwd: p.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  const closed = new Promise(r => child.once("close", r))
  let output = ""
  for (const s of [child.stdout, child.stderr]) s.on("data", d => { output += d; logs.push(String(d)) })
  const origin = `http://127.0.0.1:${port}`
  for (const end = Date.now() + 30000; ; await delay(100)) {
    assert(Date.now() < end && child.exitCode === null, `${p.label} startup: ${output.slice(-2000)}`)
    if ((await fetch(`${origin}/api/auth/status`).catch(() => undefined))?.status === 200) break
  }
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "codenomad", password }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get("set-cookie").split(";")[0]
  const call = (route, init = {}) => fetch(`${origin}${route}`, { ...init, headers: { cookie, "content-type": "application/json", ...init.headers }, signal: AbortSignal.timeout(60000) })
  const stop = async () => {
    if (p.label === "rs") { child.stdin.write("shutdown\n"); await Promise.race([closed, delay(20000)]) }
    if (child.exitCode === null) await stopFixtureHandle(child, closed)
  }
  return { call, stop }
}

const open = async (server, p) => {
  const res = await server.call("/api/workspaces", { method: "POST", body: JSON.stringify({ path: p.project }) })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}
async function converse(server, opened) {
  assert.equal(opened.status, 201, JSON.stringify(opened.body))
  const workspace = opened.body
  const base = `${workspace.proxyPath}/api/session`
  const deadline = Date.now() + 60000
  let session
  for (;;) { // the event bridge may still be reconnecting after a daemon restart
    const res = await server.call(base, { method: "POST", body: JSON.stringify({ title: "service bench" }) })
    if (res.status < 300) { session = (await res.json()).data; break }
    assert(Date.now() < deadline, `session ${res.status} ${await res.text()}`); await delay(500)
  }
  const prompt = await server.call(`${base}/${session.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "Say the fixture answer." }) })
  assert(prompt.status < 300, `prompt ${prompt.status}`)
  for (;;) {
    if ((await (await server.call(`${base}/${session.id}/message`)).text()).includes("FIXTURE_ANSWER")) return true
    assert(Date.now() < deadline, "no answer"); await delay(300)
  }
}

async function run(label) {
  const p = await profile(label)
  const logs = [], seen = {}
  let server
  try {
    server = await start(p, exe, logs)
    const first = await open(server, p)
    const started = await p.pid()
    seen.start = { status: first.status, daemonStarted: Boolean(started), binaryLabel: first.body.binaryLabel, conversation: await converse(server, first) }
    await server.stop()
    server = await start(p, exe, logs)
    const second = await open(server, p)
    seen.discovery = { status: second.status, sameDaemon: (await p.pid()) === started, conversation: await converse(server, second) }
    await p.cli("service", "stop")
    let restarted
    for (const end = Date.now() + 60000; !(restarted = await p.pid()) || restarted === started; await delay(250)) assert(Date.now() < end, "daemon not started again")
    seen.reconnection = { newDaemon: restarted !== started, conversation: await converse(server, second) }
    await server.stop()
    for (const [name, binary] of Object.entries(p.fakes)) {
      server = await start(p, binary, logs)
      const refused = await open(server, p)
      seen[name] = { status: refused.status, body: refused.body }
      await server.stop()
    }
    server = undefined
  } finally {
    await server?.stop().catch(() => {})
    await p.cli("service", "stop").catch(() => {})
    await writeFile(path.join(out, `service-${label}.log`), logs.join("").replaceAll(password, "<redacted>"))
  }
  return seen
}

const result = { binary: bin }
try {
  result.ts = await run("ts")
  result.rs = await run("rs")
  // The CLI path embeds each profile's folder: compare its file name only.
  for (const side of [result.ts, result.rs]) for (const name of ["v1", "multiline", "old"]) if (typeof side[name].body === "string") side[name].body = side[name].body.replace(/[A-Z]:\\\S+\\/g, "")
  assert.deepEqual(result.rs, result.ts)
  result.ok = true
} catch (error) {
  result.error = String(error?.stack ?? error)
  throw error
} finally {
  provider.close(); old.close()
  await writeJson("service.json", result)
}
console.log(JSON.stringify(result, null, 2))
