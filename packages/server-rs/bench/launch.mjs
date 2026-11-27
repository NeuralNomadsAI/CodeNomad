// Mode `launch`: both servers started as Tauri starts them (`cli_manager.rs` arguments,
// `CODENOMAD_NATIVE_PARENT=1`, `CLI_CONFIG`), one after the other in private homes; stdout contract
// lines, token exchange, sign-in pages, UI bundle, `tls/` and the stdin stop compared. `node launch.mjs`
import assert from "node:assert/strict"
import { spawnFixtureChild as spawn } from "../../../scripts/native-fixture-guards.mjs"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { assertPrivateHost, out, repo, rustBinary, sanitizeBenchEnvPath, useBenchTemp, writeJson } from "./fixtures.mjs"

await useBenchTemp()
const cookieName = `codenomad_session_${process.pid}_1700000000000`
const args = ["serve", "--host", "127.0.0.1", "--auth-cookie-name", cookieName, "--generate-token", "--unrestricted-root",
  "--https", "true", "--http", "true"]
const sha = text => createHash("sha256").update(text).digest("hex").slice(0, 16)

async function observe(label, command, prefix) {
  const home = path.join(out, "tmp", "launch", label)
  await rm(home, { recursive: true, force: true })
  const [config, ui, cwd] = ["config", "ui", "cwd"].map(name => path.join(home, name))
  for (const dir of [config, path.join(ui, "assets"), cwd]) await mkdir(dir, { recursive: true })
  await writeFile(path.join(ui, "index.html"), "<!doctype html><title>bench ui</title>")
  await writeFile(path.join(ui, "assets", "app.js"), "console.log(1)")
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|OS|LANG|TZ)$/i.test(key)))
  Object.assign(env, { CODENOMAD_NATIVE_PARENT: "1", CLI_CONFIG: config, CLI_UI_DIR: ui, CLI_UI_NO_UPDATE: "1",
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"),
    ProgramData: path.join(home, "ProgramData"), TEMP: home, TMP: home, TMPDIR: home })
  await sanitizeBenchEnvPath(env, { allowedRoot: home })
  await assertPrivateHost(env, home)
  const child = spawn(command, [...prefix, ...args], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  let buffer = "", log = ""
  const lines = [], waiters = []
  child.stderr.on("data", chunk => { log += chunk })
  child.stdout.on("data", chunk => {
    log += chunk
    buffer += chunk
    const parts = buffer.split("\n")
    buffer = parts.pop()
    for (const line of parts.map(l => l.trim()).filter(Boolean)) { lines.push(line); waiters.splice(0).forEach(w => w()) }
  })
  const exited = new Promise(resolve => child.on("exit", code => resolve(code)))
  const until = async (test, ms = 60000) => {
    const deadline = Date.now() + ms
    for (;;) {
      const found = lines.find(test)
      if (found) return found
      assert(Date.now() < deadline, `${label}: no matching stdout line within ${ms} ms\n${log}`)
      await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 250) })
    }
  }
  try {
    const token = (await until(l => l.startsWith("CODENOMAD_BOOTSTRAP_TOKEN:"))).slice("CODENOMAD_BOOTSTRAP_TOKEN:".length)
    const url = (await until(l => /^Local\s+Connection\s+URL\s*:/i.test(l))).match(/(https?:\/\/\S+)\s*$/i)[1]
    const remote = await until(l => l.startsWith("Remote Connection URL : "))
    const port = new URL(url).port, remotePort = new URL(remote.split(" : ")[1]).port
    const shape = text => text.replaceAll(port, "<port>").replaceAll(remotePort, "<remote>")
    const call = async (route, init = {}) => {
      const r = await fetch(url + route, { redirect: "manual", signal: AbortSignal.timeout(30000), ...init })
      const header = name => r.headers.get(name)
      const text = await r.text()
      const body = header("content-type")?.startsWith("application/json") ? JSON.parse(text) : text
      return { status: r.status, location: header("location"), type: header("content-type"), cache: header("cache-control"),
        cookie: header("set-cookie")?.replace(/=[^;]+/, "=<value>") ?? null, body: typeof body === "string" && body.length > 200 ? sha(body) : body }
    }
    const html = { accept: "text/html" }
    const exchange = () => call("/api/auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
    const o = { lines: { token: /^[A-Za-z0-9_-]{43}$/.test(token), local: shape(url), remote: shape(remote) } }
    o.anonymous = { root: await call("/", { headers: html }), login: await call("/login"), tokenPage: await call("/auth/token"),
      meta: await call("/api/meta"), status: await call("/api/auth/status"), page: await call("/some/page", { headers: html }) }
    const first = await fetch(url + "/api/auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
    const session = first.headers.get("set-cookie").split(";")[0]
    o.exchange = { status: first.status, cookie: first.headers.get("set-cookie").replace(/=[^;]+/, "=<value>"),
      name: session.split("=")[0] === cookieName, again: await exchange() }
    const signed = { headers: { cookie: session, ...html } }
    o.signed = { status: await call("/api/auth/status", signed), login: await call("/login", signed), root: await call("/", signed),
      asset: await call("/assets/app.js", signed), spa: await call("/some/page", signed) }
    const meta = JSON.parse((await fetch(url + "/api/meta", signed).then(r => r.text())))
    await writeJson(`launch-meta-${label}.json`, {
      apiContract: meta.apiContract, serverId: "<fixture>", capabilities: meta.capabilities,
    })
    const identity = (await readFile(path.join(config, "config.yaml.server-id"), "utf8")).trim()
    o.files = { identity: meta.serverId === identity && /^[0-9a-f-]{36}$/.test(identity), ui: meta.ui,
      tls: ["ca-cert.pem", "ca-key.pem", "server-cert.pem", "server-key.pem"].map(f => existsSync(path.join(config, "tls", f))) }
    child.stdin.write("codenomad:shutdown\n")
    child.stdin.end()
    o.stop = { status: await until(l => l.startsWith("CODENOMAD_SHUTDOWN_STATUS:"), 30000), exit: await exited }
    return o
  } finally {
    child.kill()
    await writeFile(path.join(out, `launch-${label}.log`), log.replaceAll(/CODENOMAD_BOOTSTRAP_TOKEN:\S+/g, "CODENOMAD_BOOTSTRAP_TOKEN:<redacted>"))
  }
}

const result = {}
try {
  result.ts = await observe("ts", process.execPath, [path.join(repo, "packages/server/dist/bin.js")])
  result.rs = await observe("rs", rustBinary(), [])
  assert.deepEqual(result.rs, result.ts)
} catch (error) {
  result.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  await writeJson("launch.json", result)
}
console.log(result.error ?? "launch: identical")
