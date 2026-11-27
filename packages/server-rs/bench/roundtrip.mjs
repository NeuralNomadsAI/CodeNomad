// Mode `roundtrip`: one private profile served by TS, then Rust, then TS again (and a fresh profile by Rust,
// then TS), on an isolated daemon and a private network address. Each server must keep and honour what
// the others wrote: TLS authority and certificates, paired and revoked devices, `config.yaml` and
// `state.yaml`, server identity, local password and agent memory. `node roundtrip.mjs <opencode executable>`
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir } from "node:fs/promises"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { assertPrivateOpenCodeExecutable, sanitizeBenchEnvPath } from "./private-profile.mjs"

const args = process.argv.slice(2)
const lanFlag = args.includes("--lan")
const rawExe = args.find(arg => !arg.startsWith("-"))
assert(path.isAbsolute(rawExe ?? ""), "usage: node roundtrip.mjs <absolute opencode executable> [--lan]")
const exe = await assertPrivateOpenCodeExecutable(rawExe)
const { spawnFixtureChild: spawn } = await import("../../../scripts/native-fixture-guards.mjs")
const { parse: parseYaml } = await import("yaml")
const { withProductRuntime } = await import("../../../scripts/native-product-fixture.mjs")
const { assertPrivateHost, fromDist, rustBinary, useBenchTemp, writeJson } = await import("./fixtures.mjs")
await useBenchTemp()
const ciEnabled = (() => {
  const raw = (process.env.CI ?? "").trim().toLowerCase()
  return raw !== "" && raw !== "0" && raw !== "false"
})()
const lanEnv = (() => {
  const raw = (process.env.CNRS_BENCH_LAN ?? "").trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "yes"
})()
const useLan = lanFlag || lanEnv
if (useLan) {
  assert(!ciEnabled, "LAN bind (--lan / CNRS_BENCH_LAN=1) is forbidden when CI is set")
}
// Bind loopback by default; direct HTTPS pairing on a private LAN IP requires explicit opt-in outside CI.
const ip = useLan
  ? Object.values(os.networkInterfaces()).flat().find(a => a?.family === "IPv4" && !a.internal
    && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))?.address
  : "127.0.0.1"
assert(ip, "No private IPv4 address for the direct HTTPS origin")
const free = host => new Promise(resolve => { const s = net.createServer().listen(0, host, () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const sha = text => createHash("sha256").update(text).digest("hex").slice(0, 16)
const json = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const result = { ip, lan: useLan, steps: [] }
const step = (name, value) => { result.steps.push({ name, value }); return value }

async function serve(label, fixture, config, extra = []) {
  const [httpPort, httpsPort] = [result.httpPort, result.httpsPort]
  const args = ["serve", "--host", ip, "--https", "true", "--http", "true", "--http-port", String(httpPort),
    "--https-port", String(httpsPort), "--generate-token", ...extra]
  const env = { ...fixture.env }
  await sanitizeBenchEnvPath(env, { allowedRoot: fixture.root })
  Object.assign(env, { CLI_CONFIG: config, CLI_UI_NO_UPDATE: "1", CNRS_FIXTURE_URL: fixture.connection.endpoint.url,
    CNRS_FIXTURE_PASSWORD: fixture.connection.endpoint.auth.password, CNRS_FIXTURE_PID: String((await fixture.client.server.info()).pid) })
  const [command, prefix] = label.startsWith("ts") ? [process.execPath, [path.join(import.meta.dirname, "ts-server.mjs")]] : [rustBinary(), []]
  await assertPrivateHost(env, fixture.root)
  const child = spawn(command, [...prefix, ...args], { cwd: fixture.root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  let log = "", buffer = ""
  const lines = []
  child.stderr.on("data", c => { log += c })
  child.stdout.on("data", c => { log += c; buffer += c; const parts = buffer.split("\n"); buffer = parts.pop(); lines.push(...parts.map(l => l.trim())) })
  const exited = new Promise(resolve => child.on("exit", resolve))
  const until = async (test, ms = 90000) => {
    for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 100))) {
      const line = lines.find(test)
      if (line) return line
      if (Date.now() > end || child.exitCode !== null) throw Error(`${label}: no expected line\n${log.slice(-3000)}`)
    }
  }
  const token = (await until(l => l.startsWith("CODENOMAD_BOOTSTRAP_TOKEN:"))).split(":")[1]
  await until(l => l.startsWith("Local Connection URL"))
  const local = (route, init = {}) => fetch(`http://127.0.0.1:${httpPort}${route}`, { signal: AbortSignal.timeout(60000), ...init })
  const ca = await readFile(path.join(config, "tls", "ca-cert.pem"), "utf8")
  // The bench client trusts the profile's authority only: the certificate must chain to it and name the address.
  const remote = (route, { method = "GET", cookie, body } = {}) => new Promise((resolve, reject) => {
    const request = https.request({ host: ip, port: httpsPort, path: route, method, ca, rejectUnauthorized: true, timeout: 60000,
      headers: { origin: `https://${ip}:${httpsPort}`, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) } },
    response => { let text = ""; response.on("data", c => { text += c }); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text })) })
    request.on("error", reject).on("timeout", () => request.destroy(Error("timeout")))
    request.end(body ? JSON.stringify(body) : undefined)
  })
  const stop = async () => {
    child.stdin.end("codenomad:shutdown\n")
    await until(l => l.startsWith("CODENOMAD_SHUTDOWN_STATUS:complete"), 30000)
    await exited
  }
  return { token, local, remote, stop, kill: () => child.kill(), log: () => log }
}

async function signIn(server, password) {
  const r = await server.local("/api/auth/login", json("POST", { username: "codenomad", password }))
  return r.status === 200 ? r.headers.get("set-cookie").split(";")[0] : r.status
}
const read = async (server, cookie, route, init = {}) => {
  const r = await server.local(route, { ...init, headers: { ...init.headers, cookie } })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function pair(server, cookie) {
  const origin = `https://${ip}:${result.httpsPort}`
  const issued = await read(server, cookie, "/api/remote-control/pairings", json("POST", { origin }))
  assert.equal(issued.status, 200, JSON.stringify(issued.body))
  const exchanged = await server.remote("/api/remote-control/pair", { method: "POST", body: { code: issued.body.url.split("#")[1] } })
  assert.equal(exchanged.status, 200, exchanged.text)
  return { id: JSON.parse(exchanged.text).device.id, cookie: exchanged.headers["set-cookie"][0].split(";")[0] }
}
const admitted = async (server, device) => JSON.parse((await server.remote("/api/auth/status", { cookie: device.cookie })).text).authenticated === true
const memory = async (server, cookie, operation, expected = 200) => {
  const r = await read(server, cookie, "/api/memory", json("POST", { operation }))
  assert.equal(r.status, expected, JSON.stringify(r.body))
  return r
}
const titles = async (server, cookie) => JSON.stringify((await memory(server, cookie, { action: "list", scope: "global" })).body)
const files = async config => Object.fromEntries(await Promise.all(["config.yaml", "state.yaml", "auth.json", "config.yaml.server-id",
  "remote-control-devices.json", "tls/ca-cert.pem", "tls/ca-key.pem", "tls/server-cert.pem", "tls/server-key.pem"]
  .map(async name => [name, await readFile(path.join(config, name), "utf8").then(sha, () => null)])))

let live
try {
  await withProductRuntime(exe, async () => ({}), async fixture => {
    result.httpPort = await free("127.0.0.1")
    result.httpsPort = await free(ip)
    const config = path.join(fixture.root, "profile")
    await mkdir(config)
    const [first, second] = [`first-${randomUUID()}`, `second-${randomUUID()}`]

    // TS creates the profile: password, preferences, memory, a paired device.
    let ts = live = await serve("ts1", fixture, config)
    const bootstrap = (await ts.local("/api/auth/token", json("POST", { token: ts.token }))).headers.get("set-cookie").split(";")[0]
    assert.equal((await read(ts, bootstrap, "/api/auth/password", json("POST", { password: first }))).status, 200)
    let cookie = await signIn(ts, first)
    const identity = (await read(ts, cookie, "/api/meta")).body.serverId
    for (const [route, patch] of [["config", { settings: { locale: "fr" } }], ["state", { recentFolders: [{ path: "kept", lastAccessed: 1 }] }]]) {
      const saved = await read(ts, cookie, `/api/storage/${route}/ui`, json("PATCH", patch))
      assert.equal(saved.status, 200, `${route}: ${JSON.stringify(saved.body)}`)
    }
    assert.equal((await read(ts, cookie, "/api/memory/settings", json("PUT", { enabled: true }))).status, 200)
    const tsDevice = useLan ? await pair(ts, cookie) : null
    if (useLan) step("ts1 device admitted", await admitted(ts, tsDevice))
    await ts.stop()
    // Agents create entries (the UI only edits them): the reference's own store writes one.
    const { MemoryStore } = await fromDist("memory/store.js")
    await new MemoryStore(config).save({ scope: "global" }, { title: "Saved by TS", type: "fact", text: "ts" }, "ses_roundtrip", () => true)
    const afterTs = step("ts1 files", await files(config))
    const tsNames = await readdir(config)
    const tsConfig = JSON.stringify(parseYaml(await readFile(path.join(config, "config.yaml"), "utf8")))

    // Rust on the same profile: same authority, devices, identity, password and memory; its changes in place.
    let rs = live = await serve("rs", fixture, config, ["--tlsSANs", "roundtrip.example"])
    cookie = await signIn(rs, first)
    assert.equal(typeof cookie, "string", "Rust refused the TS password")
    step("rs identity kept", (await read(rs, cookie, "/api/meta")).body.serverId === identity)
    if (useLan) step("rs ts device admitted", await admitted(rs, tsDevice))
    step("rs memory enabled from config.yaml", (await read(rs, cookie, "/api/memory/settings")).body)
    step("rs sees TS memory", (await titles(rs, cookie)).includes("Saved by TS"))
    for (const enabled of [false, true]) assert.equal((await read(rs, cookie, "/api/memory/settings", json("PUT", { enabled }))).status, 200)
    const entry = (await memory(rs, cookie, { action: "list", scope: "global" })).body.entries.find(e => e.title === "Saved by TS")
    await memory(rs, cookie, { action: "save", scope: "global", id: entry.id, revision: entry.revision, content: { title: "Saved by TS", type: "fact", text: "Edited by Rust" } })
    const rsDevice = useLan ? await pair(rs, cookie) : null
    if (useLan) {
      assert.equal((await read(rs, cookie, `/api/remote-control/devices/${tsDevice.id}`, { method: "DELETE" })).status, 204)
      step("rs revoked ts device", !(await admitted(rs, tsDevice)))
    }
    const rotated = await read(rs, cookie, "/api/auth/password", json("POST", { password: second }))
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body))
    await rs.stop()
    const afterRs = step("rs files", await files(config))
    step("rs kept TS files", ["state.yaml", "config.yaml.server-id", "tls/ca-cert.pem", "tls/ca-key.pem"]
      .filter(name => afterRs[name] !== afterTs[name]))
    // Either server rewrites the whole document (`yaml-doc-store.ts`), each with its own YAML rendering:
    // what TS reads back, key order included, must be unchanged.
    step("rs kept config.yaml", JSON.stringify(parseYaml(await readFile(path.join(config, "config.yaml"), "utf8"))) === tsConfig)
    step("rs issued a new leaf with the TS authority", afterRs["tls/server-cert.pem"] !== afterTs["tls/server-cert.pem"])
    step("rust-only files", (await readdir(config)).filter(name => !tsNames.includes(name)).sort())

    // TS again: everything Rust wrote reads back, nothing TS wrote was lost.
    ts = live = await serve("ts2", fixture, config)
    step("ts2 refuses the old password", await signIn(ts, first))
    cookie = await signIn(ts, second)
    assert.equal(typeof cookie, "string", "TS refused the password Rust set")
    step("ts2 identity kept", (await read(ts, cookie, "/api/meta")).body.serverId === identity)
    step("ts2 preferences", { locale: (await read(ts, cookie, "/api/storage/config/ui")).body?.settings?.locale })
    step("ts2 recent folders", (await read(ts, cookie, "/api/storage/state/ui")).body?.recentFolders)
    step("ts2 memory settings", (await read(ts, cookie, "/api/memory/settings")).body)
    const listed = await titles(ts, cookie)
    step("ts2 sees the Rust edit", listed.includes("Edited by Rust"))
    if (useLan) {
      step("ts2 rust device admitted", await admitted(ts, rsDevice))
      step("ts2 revoked ts device refused", !(await admitted(ts, tsDevice)))
      step("ts2 devices", (await read(ts, cookie, "/api/remote-control/devices")).body.devices.map(d => d.id === rsDevice.id))
    }
    await ts.stop()
    step("ts2 kept the Rust leaf", (await files(config))["tls/server-cert.pem"] === afterRs["tls/server-cert.pem"])

    // A profile Rust creates: TS (node-forge) signs a new leaf with the authority Rust wrote.
    const fresh = path.join(fixture.root, "fresh")
    await mkdir(fresh)
    rs = live = await serve("rs-fresh", fixture, fresh)
    await rs.stop()
    const rustTls = await files(fresh)
    ts = live = await serve("ts-fresh", fixture, fresh, ["--tlsSANs", "forge.example"])
    step("ts-fresh https accepted", (await ts.remote("/api/auth/status")).status)
    await ts.stop()
    const forged = await files(fresh)
    step("ts-fresh kept the Rust authority", forged["tls/ca-key.pem"] === rustTls["tls/ca-key.pem"] && forged["tls/ca-cert.pem"] === rustTls["tls/ca-cert.pem"])
    step("ts-fresh signed a new leaf", forged["tls/server-cert.pem"] !== rustTls["tls/server-cert.pem"])
    live = undefined

    const expect = {
      ...(useLan ? { "ts1 device admitted": true, "rs ts device admitted": true, "rs revoked ts device": true } : {}),
      "rs identity kept": true,
      "rs memory enabled from config.yaml": { enabled: true }, "rs sees TS memory": true,
      "rs kept TS files": [], "rs kept config.yaml": true, "rs issued a new leaf with the TS authority": true, "ts2 refuses the old password": 401,
      "ts2 identity kept": true, "ts2 preferences": { locale: "fr" }, "ts2 recent folders": [{ path: "kept", lastAccessed: 1 }],
      "ts2 memory settings": { enabled: true }, "ts2 sees the Rust edit": true,
      ...(useLan ? { "ts2 rust device admitted": true, "ts2 revoked ts device refused": true, "ts2 devices": [true] } : {}),
      "ts2 kept the Rust leaf": true, "ts-fresh https accepted": 200,
      "ts-fresh kept the Rust authority": true, "ts-fresh signed a new leaf": true,
    }
    for (const [name, value] of Object.entries(expect)) assert.deepEqual(result.steps.find(s => s.name === name)?.value, value, name)
  })
} catch (error) {
  result.error = `${error.stack}\n${live?.log().slice(-3000) ?? ""}`
  live?.kill()
  process.exitCode = 1
} finally {
  await writeJson("roundtrip.json", result)
}
console.log(result.error ?? "roundtrip: every server kept and honoured the profile")
