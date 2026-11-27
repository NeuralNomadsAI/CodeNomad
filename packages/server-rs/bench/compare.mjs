// TS/Rust comparison bench: `node compare.mjs <mode> <opencode executable>` (README.md).
// Two isolated daemons, the TS server of this checkout on one and Rust on the other; each mode
// runs the same sequence on both servers and requires identical observations.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { copyFile, cp, lstat, mkdir, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { inspect } from "node:util"
import { assertPrivateOpenCodeExecutable, assertPrivateProfile, outsideUserHome, sanitizeBenchEnvPath } from "./private-profile.mjs"

const MODES = ["http", "files", "contract", "history-bytes", "history-search", "attachment-history", "workspace-claims", "agent-controls", "remote-session-controls", "static-assets", "depth", "worktree-gone", "links", "search", "memory", "design", "automation", "missions", "missions-family", "missions-calendar", "missions-wayfinder", "mission-permissions", "host", "sidecars", "usage", "providers", "previews", "remote-previews", "solid"]
const [mode, rawExe] = process.argv.slice(2)
MODES.push("provider-logins", "receipt-worktree", "receipt-reconnect", "meta-update", "mutation-fence")
if (["prompt-admission", "command-admission"].includes(mode)) {
  await (await import("./prompt-admission.mjs")).run(mode === "command-admission")
  process.exit(process.exitCode ?? 0)
}
assert(MODES.includes(mode) && path.isAbsolute(rawExe ?? ""), `usage: node compare.mjs <${MODES.join("|")}> <absolute opencode executable>`)
const exe = await assertPrivateOpenCodeExecutable(rawExe)

const { chromium } = await import("playwright")
const { fixtureChildPid, spawnFixtureChild, stopFixtureChild } = await import("../../../scripts/native-fixture-guards.mjs")
const { dropRegistration, fromDist, installMissions, installPruning, measurePair, memory, out, privateGit, productRuntime, provisionEnv, rustBinary, useBenchTemp, waitForPruningPlugin, writeJson } = await import("./fixtures.mjs")
const { browserFiles, populate } = await import("./files.mjs")
const { browserWorktrees } = await import("./worktrees.mjs")
const bin = rustBinary()
if (mode === "attachment-history") {
  const contract = await fromDist("opencode/session-pruning/navigation-contract.js")
  assert(contract.sessionAttachmentInputSchema?.safeParse({
    sessionID: "ses_fixture", messageID: "msg_fixture", fileIndex: 0, sha256: "a".repeat(64), confirm: true,
  }).success, "The TS build and bundled pruning plugin must support attachment references and confirmation")
}
const bench = mode === "solid" ? undefined : await import(`./${mode === "http" ? "worktrees" : mode}.mjs`)
const missionServe = process.env.CNRS_BENCH_MISSIONS_SERVE === "1" || mode === "missions-wayfinder" && process.platform === "win32"
assert(!missionServe || process.platform === "win32" && ["missions", "missions-calendar", "missions-wayfinder"].includes(mode))
const runtime = missionServe ? { ...bench?.runtime, service: true } : bench?.runtime
if (runtime?.projectConfig) {
  assert(missionServe && process.env.CODENOMAD_NATIVE_FIXTURE_PARENT, "Project config requires a separate private root")
  const root = await outsideUserHome(process.env.CODENOMAD_NATIVE_FIXTURE_PARENT)
  for (let dir = root; ; dir = path.dirname(dir)) {
    for (const name of [".opencode", "opencode.json", "opencode.jsonc"]) {
      const absent = await lstat(path.join(dir, name)).then(() => false, e => e.code === "ENOENT")
      assert(absent, `Fixture ancestor contains OpenCode settings: ${dir}`)
    }
    if (path.dirname(dir) === dir) break
  }
}
await useBenchTemp()
await outsideUserHome(process.env.TEMP)
const daemonTemp = path.join(process.env.TEMP, "opencode")
await mkdir(daemonTemp, { recursive: true })
await outsideUserHome(daemonTemp)
const { resolveConfigLocation } = await fromDist("config/location.js")
const shots = path.join(out, "screenshots", mode)
await mkdir(shots, { recursive: true })

const { withProductRuntime, remove: removeRuntime } = await productRuntime({
  holdProvider: bench?.holdProvider, gitCeiling: !["history-search", "attachment-history"].includes(mode),
})

const HTTP_TIMEOUT = 20000
const STARTUP_TIMEOUT = Number(process.env.CNRS_BENCH_STARTUP_TIMEOUT_MS ?? 25000)
const result = { mode, binary: bin, tests: [], browser: {}, statuses: {}, samples: {} }
const capture = async (page, name) => {
  await page.screenshot({ path: path.join(shots, `${name}.png`), animations: "disabled" })
  ;(result.browser.screenshots ??= []).push(`${name}.png`)
}
const statusOf = async value => (await value).status
const jsonBody = data => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) })
const withCookie = (cookie, init = {}) => ({ ...init, headers: { ...init.headers, cookie } })
async function eventually(check, label, ms = 12000) {
  for (const end = Date.now() + ms; Date.now() < end; await delay(60)) {
    const value = await check()
    if (value) return value
  }
  throw Error(`Timed out: ${label}`)
}
async function unusedPort() {
  const socket = net.createServer()
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve))
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  return port
}

/** A scripted desktop host on a child's native channel (`native-parent.ts`): every request is recorded
 * and answered by `answer(method, params)`, by default a refusal. */
function nativeHost(child) {
  const native = { requests: [], answer: () => ({ ok: false, error: { code: "fixture", message: "No fixture answer" } }) }
  let pending = ""
  child.stdout.on("data", chunk => {
    pending += chunk
    for (let at; (at = pending.indexOf("\n")) >= 0;) {
      const line = pending.slice(0, at).trim()
      pending = pending.slice(at + 1)
      if (!line.startsWith("CODENOMAD_NATIVE_REQUEST:")) continue
      const request = JSON.parse(line.slice("CODENOMAD_NATIVE_REQUEST:".length))
      native.requests.push({ method: request.method, params: request.params })
      Promise.resolve(native.answer(request.method, request.params)).then(reply =>
        child.stdin.write(`CODENOMAD_NATIVE_RESPONSE:${JSON.stringify({ v: 1, id: request.id, ...reply })}\n`))
    }
  })
  return native
}

async function start(label, fixture, folder, password, trustedCA) {
  const port = await unusedPort()
  const info = await fixture.client.server.info()
  const root = fixture.root
  const listen = `http://127.0.0.1:${port}`
  const env = { ...fixture.env, CNRS_FIXTURE_URL: fixture.connection.endpoint.url,
    CNRS_FIXTURE_PASSWORD: fixture.connection.endpoint.auth.password, CNRS_FIXTURE_PID: String(info.pid),
    CNRS_SERVER_PASSWORD: password, CODENOMAD_SERVER_PASSWORD: password }
  // The automation mode answers each server's native channel as a desktop host does.
  const scripted = mode === "automation"
  if (scripted) env.CODENOMAD_NATIVE_PARENT = "1"
  if (label === "ts") Object.assign(env, { CODENOMAD_REMOTE_CONTROL: "disabled", CNRS_FIXTURE_TRUSTED_CA: trustedCA })
  else Object.assign(env, { CNRS_HTTPS_BIND: "127.0.0.1:0", CNRS_HTTPS_NAME: "127.0.0.1", CNRS_FIXTURE_INGRESS: "1",
    CNRS_FIXTURE_MISSIONS_READ: "1", CNRS_FIXTURE_MISSIONS_RUN: "1",
    ...(mode === "memory" ? provisionEnv(root, "memory") : mode === "design" || mode === "host" ? provisionEnv(root) : {}) })
  // `host`: both servers as the desktop hosts start them, over the whole filesystem, on equal settings.
  if (mode === "host") Object.assign(env, { CLI_UNRESTRICTED_ROOT: "true", CODENOMAD_REMOTE_CONTROL: "disabled" })
  Object.assign(env, bench?.environment?.(root) ?? {})
  if (label === "ts" && (bench?.remoteIngress || bench?.remoteDirect)) {
    delete env.CODENOMAD_REMOTE_CONTROL
    if (bench.remoteIngress) env.CNRS_PREVIEW_TEST_TUNNEL = "1"
    else env.CODENOMAD_ALLOWED_ORIGINS = bench.remoteDirect
  }
  if (label === "rs" && bench?.remoteDirect) {
    delete env.CNRS_FIXTURE_INGRESS
    env.CNRS_HTTPS_NAME = new URL(bench.remoteDirect).hostname
  }
  // Modes that seed `config.yaml` start both servers on equal settings.
  // Keep the Rust settings at their private positional default in modes without a seeded YAML.
  const serve = label === "rs" && missionServe
  env.CLI_CONFIG = label === "ts" ? path.join(root, "ts.yaml")
    : path.join(root, serve || mode === "host" || bench?.configure ? "rust.yaml" : "rust.data")
  await sanitizeBenchEnvPath(env, { allowedRoot: root })
  await assertPrivateProfile(root, env, resolveConfigLocation(env.CLI_CONFIG))
  const uiDir = await bench?.ui?.(root) ?? path.join(out, "ui")
  if (bench?.ui) env.CNRS_FIXTURE_UI_DIR = uiDir
  let rust = bin
  let rustArgs = [folder, path.join(root, "rust.json"), String(port), exe]
  if (serve) {
    // A read-only CLI shim proves this owned connection and cannot start a daemon.
    const cli = path.join(root, "mission-opencode.cmd")
    env.FIXTURE_NATIVE_URL = new URL(fixture.connection.endpoint.url).origin
    env.FIXTURE_NATIVE_PASSWORD = fixture.connection.endpoint.auth.password
    assert.match(env.FIXTURE_NATIVE_URL, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert(/^[A-Za-z0-9_-]{16,128}$/.test(env.FIXTURE_NATIVE_PASSWORD), "Unexpected private service credential format")
    await writeFile(cli, '@echo off\r\nif "%*"=="service status" (echo %FIXTURE_NATIVE_URL%& exit /b 0)\r\nif "%*"=="service get password" (echo %FIXTURE_NATIVE_PASSWORD%& exit /b 0)\r\nexit /b 1\r\n', { flag: "wx" })
    const seeded = await bench.configure?.(fixture) ?? ""
    await writeFile(env.CLI_CONFIG, `server:\n  opencodeBinary: ${JSON.stringify(cli)}\n${seeded}`)
    rust = path.join(root, "server", path.basename(bin))
    await mkdir(path.dirname(rust))
    await copyFile(bin, rust)
    await cp(new URL("plugins/", new URL("../../server/dist/", import.meta.url)), path.join(path.dirname(rust), "plugins"), { recursive: true })
    rustArgs = ["serve", "--http", "true", "--http-port", String(port), "--https", "false",
      "--ui-dir", uiDir, "--workspace-root", folder]
  }
  const relay = await bench?.nativeRelay?.(fixture)
  if (relay) env.CNRS_FIXTURE_URL = relay.url
  let child
  try {
    child = label === "ts"
      ? spawnFixtureChild(process.execPath, [path.join(import.meta.dirname, "ts-server.mjs"), "--http", "true", "--http-port", String(port), "--https", "false",
        "--ui-no-update", "--ui-dir", uiDir, "--config", env.CLI_CONFIG, "--workspace-root", folder],
        { env, cwd: root, windowsHide: true, stdio: [scripted ? "pipe" : "ignore", "pipe", "pipe"] })
      : spawnFixtureChild(rust, rustArgs, { env, cwd: root, windowsHide: true, stdio: [scripted || serve ? "pipe" : "ignore", "pipe", "pipe"] })
  } catch (error) {
    await relay?.close()
    throw error
  }
  const stopped = new Promise(resolve => child.once("close", resolve))
  let output = "", spawnError
  child.on("error", error => { spawnError = error })
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data })
  const native = scripted ? nativeHost(child) : undefined
  const pid = fixtureChildPid(child)
  const request = (route, init) => fetch(`${listen}${route}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT), redirect: "manual", ...init })
  const close = async () => {
    try {
      if (!spawnError) await stopFixtureChild(child, stopped, serve ? 15_000 : 1_000, 2_000, {
        close: serve ? () => child.stdin.end("codenomad:shutdown\n") : undefined,
      })
    } finally {
      try { await relay?.close() } finally { await dropRegistration(fixture.env, await pid) }
    }
    const leaked = (bench?.secrets?.() ?? []).filter(secret => output.includes(secret))
    const safe = leaked.reduce((text, secret) => text.replaceAll(secret, "<redacted>"), output)
    await writeFile(path.join(out, `${mode}-${label}.log`), safe.replaceAll(password, "<redacted>").replaceAll(env.CNRS_FIXTURE_PASSWORD, "<redacted>"))
    if (leaked.length) (result.leaks ??= []).push({ label, count: leaked.length })
  }
  try {
    await eventually(async () => {
      if (spawnError || child.exitCode !== null) throw Error(`${label} startup: ${spawnError ?? output.slice(-2500)}`)
      return (await request("/api/auth/status").catch(() => undefined))?.status === 200 && (label !== "ts" || output.includes("Local Connection URL"))
    }, `${label} startup`, STARTUP_TIMEOUT).catch(error => { throw Error(`${error.message}\n${output.slice(-2500)}`, { cause: error }) })
    const ingress = () => /^CNRS_TEST_INGRESS (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output)?.[1]
    return { request, close, native, origin: listen, secureOrigin: /^HTTPS (https:\/\/\S+)$/m.exec(output)?.[1]?.trim(), ingress, pid: await pid, status: info.version, daemonPID: info.pid }
  } catch (e) { await close(); throw e }
}

async function signIn(host, password) {
  const login = await host.request("/api/auth/login", jsonBody({ username: "codenomad", password }))
  assert.equal(login.status, 200)
  const cookie = login.headers.get("set-cookie")
  assert.ok(/^codenomad_session=[A-Za-z0-9_-]{43}; HttpOnly; Path=\/; SameSite=Lax; Max-Age=604800$/.test(cookie), "Unexpected login cookie attributes")
  return cookie.split(";", 1)[0]
}

/** Run before every mode: authentication on both servers, then Rust's local admission surface. */
async function qualify(ts, rs, password, rsRoot) {
  for (const host of [ts, rs]) {
    assert.deepEqual(await (await host.request("/api/auth/status")).json(), { authenticated: false })
    assert.equal(await statusOf(host.request("/api/meta")), 401)
    assert.equal(await statusOf(host.request("/api/auth/login", jsonBody({ username: "codenomad", password: "wrong" }))), 401)
    for (const source of [{ origin: "http://127.0.0.1:1" }, { referer: "https://other.invalid/" }, { origin: "null" }]) {
      const init = jsonBody({ username: "codenomad", password })
      assert.equal(await statusOf(host.request("/api/auth/login", { ...init, headers: { ...init.headers, ...source } })), 403)
    }
    const cookie = await signIn(host, password)
    assert.deepEqual(await (await host.request("/api/auth/status", withCookie(cookie))).json(), { authenticated: true, username: "codenomad", passwordUserProvided: true })
    assert.equal(await statusOf(host.request("/api/meta", withCookie(cookie))), 200)
    if (missionServe && host === rs)
      assert((await (await host.request("/api/meta", withCookie(cookie))).json()).capabilities.includes("missions"))
    // Sign-out is not ported (decision): its route answers on the reference only.
    if (host === ts) {
      assert.equal(await statusOf(host.request("/api/auth/logout", withCookie(cookie, { method: "POST" }))), 200)
      assert.equal(await statusOf(host.request("/api/meta", withCookie(cookie))), 401)
    }
  }
  const cookie = await signIn(rs, password)
  const call = (route, init) => rs.request(route, withCookie(cookie, init))
  const callStatus = (route, init) => statusOf(call(route, init))
  assert.equal(await callStatus("/api/meta", { headers: { "x-codenomad-server-request": "1" } }), 401)
  assert.equal(await callStatus("/api/meta", { headers: { "x-codenomad-backend-authority": "bootstrap" } }), 403)
  assert.equal(await callStatus("/api/auth/login", { ...jsonBody({ username: "codenomad", password }), headers: { "content-type": "application/json", "x-forwarded-proto": "https" } }), 403)
  assert.equal(await callStatus("/api/remote-control/server-pair", { ...jsonBody({ code: "a".repeat(32) }), headers: { "content-type": "application/json", "x-codenomad-server-pairing": "1" } }), 404)
  result.tests.push("password, cookies, cross-origin and Referer (TS + RS), logout (TS), unsupported device/authority/pairing (RS)")
  // Lexical refusals before any disk access: outside the root without `--unrestricted-root`; network,
  // verbatim and device paths in both cases.
  const outside = mode === "host" ? [] : [path.dirname(rsRoot)]
  for (const refused of [...outside, String.raw`\\fixture.invalid\share\x`, String.raw`\\?\C:\Windows`, String.raw`\\.\pipe\x`, "C:\\Windows\\NUL"]) {
    assert.equal(await callStatus(`/api/filesystem?path=${encodeURIComponent(refused)}`), 400, refused)
    assert.equal(await callStatus("/api/filesystem/folders", jsonBody({ parentPath: refused, name: "x" })), 400, refused)
    assert.equal(await callStatus("/api/workspaces", jsonBody({ path: refused })), 400, refused)
  }
  if (mode === "host") assert.equal(await callStatus(`/api/filesystem?path=${encodeURIComponent(path.dirname(rsRoot))}`), 200)
  assert((await (await call("/api/filesystem")).json()).entries.some(e => e.name === "Rust Project"))
  const open = requestId => call("/api/workspaces", jsonBody({ path: "Rust Project", requestId }))
  const opening = await open("release-test")
  assert.equal(opening.status, 201)
  const ws = await opening.json()
  assert.equal(await statusOf(open("release-test")), 400)
  assert.equal(await callStatus(`/api/workspaces/${ws.id}/creation/release`, jsonBody({ requestId: "foreign" })), 404)
  for (let i = 0; i < 2; i++) assert.equal(await callStatus(`/api/workspaces/${ws.id}/creation/release`, jsonBody({ requestId: "release-test" })), 204)
  assert.equal(await callStatus("/api/workspaces/creation/cancel", jsonBody({ requestId: "release-test" })), 204)
  assert.equal((await (await call(`/api/workspaces/${ws.id}`)).json()).requestId, undefined)
  const byId = `/api/storage/instances/${ws.id}`
  const byPath = `/api/storage/instances/${encodeURIComponent(path.join(rsRoot, "Rust Project"))}`
  const state = { messageHistory: ["fixture"], agentModelSelections: { build: { providerId: "fixture", modelId: "fixture" } } }
  assert.equal(await callStatus(byId, { ...jsonBody(state), method: "PUT" }), 204)
  assert.deepEqual(await (await call(byPath)).json(), state)
  assert.equal(await callStatus(byPath, { method: "DELETE" }), 204)
  assert.deepEqual(await (await call(byId)).json(), { messageHistory: [], agentModelSelections: {} })
  const worktrees = await (await call(`/api/workspaces/${ws.id}/worktrees`)).json()
  assert.equal(worktrees.isGitRepo, true)
  assert.deepEqual(worktrees.worktrees.map(w => w.directory), [ws.path])
  const pending = `/api/workspaces/${ws.id}/pending-requests`
  const snapshot = await call(`${pending}?directories=${encodeURIComponent(ws.path)}`)
  assert.equal(snapshot.headers.get("cache-control"), "no-store")
  const payload = await snapshot.json()
  assert.equal(payload.supported, true)
  assert.equal(payload.directories[0].status, "ok")
  assert.equal(await callStatus(`${pending}?directories=${encodeURIComponent(rsRoot)}`), 403)
  assert.equal(await callStatus(`/api/workspaces/${ws.id}`, { method: "DELETE" }), 204)
  const cancelled = await (await open("cancel-test")).json()
  assert.equal(await callStatus("/api/workspaces/creation/cancel", jsonBody({ requestId: "cancel-test" })), 204)
  assert.equal(await callStatus(`/api/workspaces/${cancelled.id}`), 404)
  result.tests.push("restricted filesystem, workspace claims, root worktree, instance storage and pending snapshot (RS)")
}

/** Warm up TS's project folder and pruning plugin with the same budget as `rustPruning.ready`. */
async function warmTsPruning(tsHost, client, folder, directory) {
  const opened = await tsHost.call("/api/workspaces", jsonBody({ path: folder }))
  assert.equal(opened.status, 201)
  const { id, location } = await opened.json()
  let failed = false
  try {
    await waitForPruningPlugin(client, location?.directory ?? directory)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      const closed = await tsHost.call(`/api/workspaces/${id}`, { method: "DELETE" })
      if (!failed) assert.equal(closed.status, 204)
    } catch (cleanupError) {
      if (!failed) throw cleanupError
    }
  }
}

function formatError(error, depth = 0, seen = new Set()) {
  if (!error || typeof error !== "object") return String(error)
  if (seen.has(error)) return "[Circular]"
  seen.add(error)
  try {
    const text = typeof error.stack === "string" && error.stack.length > 0 ? error.stack : inspect(error, { depth: 3 })
    if (depth >= 4) return text
    const extras = []
    if (Array.isArray(error.errors) && error.errors.length) {
      extras.push(...error.errors.map((item, i) => `Error[${i}]: ${formatError(item, depth + 1, seen)}`))
    }
    if (error.cause !== undefined) {
      extras.push(`Caused by: ${formatError(error.cause, depth + 1, seen)}`)
    }
    return extras.length ? `${text}\n${extras.join("\n")}` : text
  } finally {
    seen.delete(error)
  }
}

/** Both servers through one sequence each; their observations must be identical. */
async function compareSides(sides) {
  const settle = run => run.then(value => value, error => ({ error: formatError(error), partial: error?.partial }))
  const order = mode === "missions-family" && process.env.CNRS_BENCH_RS_FIRST === "1" ? [1, 0] : [0, 1]
  for (const i of order) result[i === 0 ? "typescript" : "rust"] = await settle(bench.run(sides[i]))
  assert(!result.typescript.error && !result.rust.error, "a bench sequence raised")
  const comparable = bench.comparable ?? (value => value)
  assert.deepEqual(comparable(result.rust), comparable(result.typescript))
}

/** Solid, served by the TS server, pairs with Rust over HTTPS, prompts twice, isolates two tabs, then worktrees and Files. */
async function solid({ ts, rs, local, remote, tsRoot, rsRoot, password }) {
  const localBaseline = local.requests.length, remoteBaseline = remote.requests.length
  const localCookie = await signIn(ts, password)
  const profile = { id: "rust2", name: "Serveur Rust", baseUrl: rs.secureOrigin, skipTlsVerify: false }
  assert.match(profile.baseUrl, /^https:\/\/127\.0\.0\.1:/)
  const seed = async (route, payload, method) => {
    const init = jsonBody(payload)
    const res = await ts.request(route, { ...withCookie(localCookie, { ...init, headers: { ...init.headers, origin: ts.origin } }), method })
    assert(res.ok, `${method} ${route} ${res.status}: ${await res.text()}`)
  }
  // Only what a user could save: the Rust profile and the local workspace. Nothing in the UI is mocked.
  await seed("/api/storage/state/ui", { remoteServers: [profile], recentFolders: [{ path: path.join(tsRoot, "Local Project"), projectName: "Local Project", lastAccessed: Date.now() }] }, "PATCH")
  const issued = await rs.request("/api/remote-control/pairings", withCookie(await signIn(rs, password), { method: "POST" }))
  assert.equal(issued.status, 200)
  const { url: pairingLink } = await issued.json()
  await seed("/api/workspaces", { path: "Local Project", name: "Local Project" }, "POST")
  let browser, page
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CODENOMAD_BROWSER_PATH })
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 960 } })
    await context.addInitScript(() => {
      const sources = new Set()
      window.fixtureTrace = []
      window.fixtureErrorToasts = []
      new MutationObserver(() => {
        for (const toast of document.querySelectorAll('[role="status"] [class~="border-rose-800"], [role="status"][class~="border-rose-800"]')) {
          const text = toast.textContent?.trim()
          if (text && !window.fixtureErrorToasts.includes(text)) window.fixtureErrorToasts.push(text)
        }
      }).observe(document, { childList: true, subtree: true })
      window.EventSource = class ObservedEventSource extends EventSource {
        constructor(url, options) {
          super(url, options)
          sources.add(this)
          this.addEventListener("message", input => {
            const frame = JSON.parse(input.data)
            if (frame.type === "instance.event" && frame.event?.data?.sessionID) window.fixtureTrace.push({
              path: new URL(this.url).pathname, sessionID: frame.event.data.sessionID, type: frame.event.type, id: frame.event.id })
          })
        }
        close() { sources.delete(this); super.close() }
      }
      window.fixtureEventUrls = () => [...sources].map(source => source.url)
    })
    page = await context.newPage()
    page.setDefaultTimeout(30000)
    page.on("response", res => {
      const url = new URL(res.url())
      if (url.origin !== ts.origin || !/^\/(api|workspaces)\//.test(url.pathname)) return
      const key = `${res.request().method()} ${url.pathname} → ${res.status()}`
      result.statuses[key] = (result.statuses[key] ?? 0) + 1
      if (res.status() >= 400 && url.pathname.startsWith("/api/backends/rust2/")) void res.text().then(body => {
        (result.browser.refusals ??= []).push({ method: res.request().method(), path: url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ":id"), query: url.search, status: res.status(), body: body.slice(0, 300) })
      }).catch(() => {})
      if (url.pathname.startsWith("/api/backends/rust2/") && url.pathname.endsWith("/instance/api/session") && url.searchParams.has("project"))
        (result.browser.projectLists ??= []).push({ path: url.pathname, query: url.search, status: res.status() })
    })
    const inflight = new Map()
    page.on("request", req => { const u = new URL(req.url()); if (u.origin === ts.origin && !/\/events$/.test(u.pathname)) inflight.set(req, `${req.method()} ${u.pathname}${u.search} @${Date.now()}`) })
    for (const done of ["requestfinished", "requestfailed"]) page.on(done, req => inflight.delete(req))
    page.on("pageerror", e => console.log("PAGE ERROR", String(e)))
    page.on("crash", () => console.log("PAGE CRASH"))
    page.on("console", message => {
      if (["warning", "error"].includes(message.type()) && !message.text().startsWith("Failed to load resource:")) console.log("BROWSER", message.text().slice(0, 450))
    })
    await context.addCookies([{ name: "codenomad_session", value: localCookie.split("=")[1], url: ts.origin, httpOnly: true, sameSite: "Lax" }])
    await page.goto(ts.origin, { waitUntil: "domcontentloaded", timeout: 15000 })
    try { await journey(page) } catch (e) {
      result.browser.inflightAtFailure = [...inflight.values()]
      console.log("IN FLIGHT", JSON.stringify(result.browser.inflightAtFailure))
      console.log(await page.locator("body").innerText().catch(() => ""))
      await capture(page, "diagnostic").catch(() => {})
      throw e
    }
  } finally { await browser?.close() }

  async function journey(page) {
    await page.getByRole("button", { name: "Open settings", exact: true }).filter({ visible: true }).first().click()
    await page.getByRole("button", { name: "Servers", exact: true }).click()
    const field = page.locator(".settings-screen-content [data-server-add-field]")
    await field.fill(pairingLink)
    const [connected] = await Promise.all([page.waitForResponse(res => new URL(res.url()).pathname === "/api/remote-servers/rust2/connect"), field.press("Enter")])
    assert.equal(connected.status(), 200)
    await capture(page, "00-appairage-solid")
    await page.getByRole("button", { name: "Close settings", exact: true }).click()
    const device = (await (await rs.request("/api/remote-control/devices", withCookie(await signIn(rs, password)))).json()).devices[0]
    assert(device && !device.origin)
    result.browser.pairedThroughSolid = true
    await page.getByRole("tab", { name: "Browse", exact: true }).click()
    await page.getByRole("button", { name: `Open a project on ${profile.name}`, exact: true }).click()
    const remotes = page.locator(".remote-server-browser")
    await capture(page, "01-serveur")
    const folder = remotes.getByRole("button", { name: "Rust Project", exact: true })
    await folder.waitFor()
    await capture(page, "02-dossiers")
    await folder.click()
    await page.waitForFunction(() => document.querySelector(".remote-server-browser [data-can-go]")?.value?.trim().endsWith("Rust Project"))
    const admitted = page.waitForResponse(res => new URL(res.url()).pathname === "/api/backends/rust2/api/meta" && res.status() === 200)
    const released = page.waitForResponse(res => /^\/api\/backends\/rust2\/api\/workspaces\/[^/]+\/creation\/release$/.test(new URL(res.url()).pathname))
    await remotes.locator("[data-remote-open]").click()
    assert.match((await (await admitted).allHeaders())["x-codenomad-backend-authority"], /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await released).status(), 204)
    result.browser.admitted = true
    await page.getByRole("tab", { name: "Status", exact: true }).waitFor()
    await capture(page, "03-projet")
    const editor = page.getByPlaceholder(/type your message/i).first()
    await editor.fill("Réponds avec le texte synthétique du banc de test.")
    const send = page.getByRole("button", { name: "Send message", exact: true })
    result.samples.idle = await memory([ts.pid, rs.pid])
    const promptRoute = res => /\/api\/backends\/rust2\/workspaces\/.+\/api\/session\/.+\/prompt$/.test(new URL(res.url()).pathname)
    const [firstResponse] = await Promise.all([page.waitForResponse(promptRoute), send.click(), (async () => {
      await eventually(() => remote.requests.length > remoteBaseline, "synthetic provider call")
      result.samples.duringRustPrompt = await memory([ts.pid, rs.pid])
    })()])
    assert.equal(firstResponse.status(), 200)
    const promptSession = new URL(firstResponse.url()).pathname.split("/").at(-2)
    await page.getByText("FIXTURE_ANSWER", { exact: true }).first().waitFor()
    // Exactly one native terminal event per prompt, then no WORKING status left.
    const settled = async count => {
      const terminal = e => /^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)
      const events = await eventually(async () => {
        const trace = await page.evaluate(session => window.fixtureTrace.filter(e => e.sessionID === session), promptSession)
        return trace.filter(terminal).length >= count ? trace : undefined
      }, `terminal event ${count}`)
      assert.deepEqual(events.filter(terminal).map(e => e.type), Array(count).fill("session.execution.succeeded"))
      await page.getByText("WORKING", { exact: true }).filter({ visible: true }).first().waitFor({ state: "hidden" })
    }
    await settled(1)
    assert.equal(local.requests.length, localBaseline)
    await capture(page, "04-transcript")
    const localEvents = (await page.evaluate(() => window.fixtureEventUrls())).map(value => new URL(value)).find(url => url.pathname === "/api/events")
    assert(localEvents)
    const secondPrompt = "Deuxième prompt via le relais HTTPS."
    await editor.fill(secondPrompt)
    const [secondSend] = await Promise.all([page.waitForResponse(promptRoute), send.click()])
    assert.equal(secondSend.status(), 200)
    await eventually(async () => await page.getByText("FIXTURE_ANSWER", { exact: true }).count() >= 2, "second transcript")
    await settled(2)
    assert((await page.evaluate(() => window.fixtureEventUrls())).includes(localEvents.href))
    assert.equal(local.requests.length, localBaseline)
    assert.deepEqual((await (await ts.request("/api/workspaces", withCookie(localCookie))).json()).map(w => w.name), ["Local Project"])
    const trace = await page.evaluate(session => window.fixtureTrace.filter(e => e.sessionID === session), promptSession)
    assert(trace.some(e => e.type === "session.text.delta"))
    assert(trace.every(e => e.path === "/api/backends/rust2/api/events"))
    assert.equal(new Set(trace.map(e => e.id)).size, trace.length)
    result.browser.sessionEvents = trace.length
    result.browser.providerCalls = { local: local.requests.length - localBaseline, remote: remote.requests.length - remoteBaseline }
    await capture(page, "06-deuxieme-message")
    await page.getByRole("button", { name: "New instance", exact: true }).click()
    await page.locator(".folder-home-recent-primary-action").filter({ visible: true })
      .and(page.getByRole("button", { name: /^Local Project · This computer · / })).click({ timeout: STARTUP_TIMEOUT })
    await page.getByRole("tab", { name: /Local Project/, selected: true }).waitFor()
    await page.getByRole("tab", { name: "Files", exact: true }).waitFor()
    await page.getByRole("tab", { name: "Missions", exact: true }).waitFor()
    await capture(page, "08-panneaux-locaux")
    await page.getByText(secondPrompt, { exact: true }).first().waitFor({ state: "hidden" })
    assert.equal(await page.getByText("FIXTURE_ANSWER", { exact: true }).filter({ visible: true }).count(), 0)
    await page.getByRole("tab", { name: /Rust Project/ }).click()
    await page.getByRole("tab", { name: /Rust Project/, selected: true }).waitFor()
    await page.getByText("FIXTURE_ANSWER", { exact: true }).first().waitFor()
    result.browser.twoTabsIsolated = true
    await capture(page, "07-deux-backends")
    result.browser.worktrees = await browserWorktrees(page, capture, STARTUP_TIMEOUT)
    result.browser.files = await browserFiles(page, capture, path.join(rsRoot, "Rust Project"))
    result.samples.afterFullPath = await measurePair(ts, rs)
    for (const key of ["privateBytes", "workingSet"]) assert(result.samples.afterFullPath.rust[key] < 48 * 1048576,
      `Memory budget after full path: Rust ${key} median ${result.samples.afterFullPath.rust[key]} exceeds 48 MiB`)
    for (const text of ["Unable to load sessions", "Full timeline unavailable", "Could not load permission decisions.",
      "questions and permissions not fully recovered", "Some waiting questions may be missing"])
      assert.equal(await page.getByText(text, { exact: false }).filter({ visible: true }).count(), 0, text)
    result.browser.errorToasts = await page.evaluate(() => window.fixtureErrorToasts)
    assert.deepEqual(result.browser.errorToasts, [])
    assert.equal(await page.getByText(/not implemented/i).filter({ visible: true }).count(), 0)
  }
}

let rustPruning, missionsPresence
const prepare = async fixture => {
  if (mode === "depth") await (await import("./depth.mjs")).prepare(fixture)
  return (await bench?.prepare?.(fixture)) ?? {}
}
try {
  await withProductRuntime(exe, async fixture => {
    await privateGit(path.join(fixture.root, "local", "Local Project"), "typescript-study")
    return prepare(fixture)
  }, async local => withProductRuntime(exe, async fixture => {
    if (!missionServe) missionsPresence = await installMissions(fixture)
    await privateGit(path.join(fixture.root, "remote", "Rust Project"), "rust-study")
    if (!missionServe) rustPruning = await installPruning(fixture)
    return prepare(fixture)
  }, async remote => {
    const password = randomUUID()
    const tsRoot = path.join(local.root, "local"), rsRoot = path.join(remote.root, "remote")
    for (const root of [tsRoot, rsRoot]) {
      if (mode.startsWith("missions")) await mkdir(path.join(root, "Rich"))
      else await populate(path.join(root, "Rich"), true)
      await mkdir(path.join(root, "No Repository"))
    }
    await populate(path.join(rsRoot, "Rust Project"))
    await populate(path.join(tsRoot, "Local Project"))
    await rustPruning?.ready(remote.client, path.join(rsRoot, "Rust Project"))
    const seeded = (await bench?.configure?.(local, remote)) ?? ""
    const settings = `server:\n  opencodeBinary: ${JSON.stringify(exe)}\n${seeded}ui:\n  settings:\n    multiBackend: true\n    locale: en\n`
    await writeFile(path.join(local.root, "ts.yaml"), settings)
    if (mode === "host" || bench?.configure) await writeFile(path.join(remote.root, "rust.yaml"), settings)
    let ts, rs, sequenceFailed = false
    try {
      rs = await start("rs", remote, rsRoot, password)
      ts = await start("ts", local, tsRoot, password, missionServe ? undefined : path.join(remote.root, "rust.data", "tls", "ca-cert.pem"))
      assert.notEqual(ts.daemonPID, rs.daemonPID)
      result.daemons = [ts.status, rs.status]
      // Modes that open and authenticate their own workspaces (or run dedicated
      // mutation-fence scenarios) skip the generic pending-question qualification.
      if (!["attachment-history", "history-search", "receipt-reconnect", "meta-update", "mutation-fence"].includes(mode)) await qualify(ts, rs, password, rsRoot)
      if (mode === "solid") return await solid({ ts, rs, local, remote, tsRoot, rsRoot, password })
      const hosts = []
      for (const host of [ts, rs]) {
        const cookie = await signIn(host, password)
        hosts.push({ call: (route, init) => host.request(route, withCookie(cookie, init)), origin: host.origin, cookie,
          ...(bench?.remoteIngress || bench?.remoteDirect ? { secureOrigin: host.secureOrigin, ingress: host.ingress } : {}) })
      }
      if (!missionServe && ["attachment-history", "history-search", "history-bytes", "contract"].includes(mode)) {
        await warmTsPruning(hosts[0], local.client, "Local Project", path.join(tsRoot, "Local Project"))
      }
      if (bench.pair) { result[mode] = await bench.pair(...hosts); return }
      await compareSides([
        { ...hosts[0], exe, fixture: local, folder: "Local Project", root: tsRoot, other: path.join(tsRoot, "No Repository"), pid: ts.pid, native: ts.native },
        { ...hosts[1], exe, fixture: remote, folder: "Rust Project", root: rsRoot, other: path.join(rsRoot, "No Repository"), pid: rs.pid, native: rs.native, data: path.join(remote.root, "rust.data") },
      ])
    } catch (error) {
      sequenceFailed = true
      throw error
    } finally {
      const closed = await Promise.allSettled([ts?.close(), rs?.close(), bench?.close?.()])
      const errors = closed.flatMap(item => item.status === "rejected" ? [String(item.reason?.stack ?? item.reason)] : [])
      if (errors.length) {
        result.cleanupErrors = errors
        if (!sequenceFailed) throw new Error(`Bench teardown failed:\n${errors.join("\n")}`)
      }
    }
    assert(!result.leaks, "A server logged a synthetic provider credential")
  }, runtime), runtime)
} catch (error) {
  result.error = formatError(error)
  console.error(result.error)
  process.exitCode = 1
} finally {
  const settled = await Promise.allSettled([rustPruning?.close(), missionsPresence?.(), removeRuntime()])
  const cleanupErrors = settled
    .filter(item => item.status === "rejected")
    .map(item => formatError(item.reason))
  if (cleanupErrors.length) {
    result.cleanupErrors = [...(result.cleanupErrors ?? []), ...cleanupErrors]
    if (!result.error) {
      result.error = `Bench cleanup failed:\n${cleanupErrors.join("\n")}`
      console.error(result.error)
      process.exitCode = 1
    }
  }
  let reportError
  try {
    await writeJson(`${mode}.json`, result)
  } catch (error) {
    reportError = error
    console.error(formatError(error))
    process.exitCode = 1
  }
  if (!reportError) {
    console.log(`${mode}: ${result.error ? "FAILED" : "identical"} → ${path.join(out, `${mode}.json`)}`)
  }
  if (reportError && !result.error) throw reportError
}
