// Mode `opencode-install`: OpenCode installed by each server on a machine without it (Windows).
// TS installs through npm (`installSharedOpenCode`), Rust without Node (`codenomad-rs opencode`),
// each in its own private profile (home, AppData, npm prefix, npmrc, cache) against a loopback
// registry that requires a token (the `@opencode` scope of the private npmrc). Steps: a foreign
// PATH OpenCode (superseded, current), a running 2.0.14, fresh install, update, a tampered package,
// then Rust's rollback; every layout is read by the TS functions and by Rust alike. Neither the account's npm
// prefix nor its user PATH may change. `node opencode-install.mjs`
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import path from "node:path"
import { promisify } from "node:util"
import { gzipSync } from "node:zlib"
import { startFakeNpmRegistry } from "../../../scripts/fixtures/fake-npm-registry.mjs"
import { dist, out, rustBinary, useBenchTemp, writeJson } from "./fixtures.mjs"

assert.equal(process.platform, "win32", "Windows only")
const run = promisify(execFile)
const bin = rustBinary()
await useBenchTemp()
const root = path.join(out, "tmp", "opencode", `install-${Date.now()}`)
await mkdir(root, { recursive: true })
const sha = bytes => createHash("sha256").update(bytes).digest("hex").slice(0, 16)

// The account's state that must not move.
const userPrefix = path.join(process.env.APPDATA, "npm")
const accountState = async () => ({
  path: (await run("reg", ["query", "HKCU\\Environment", "/v", "Path"], { windowsHide: true }).catch(() => ({ stdout: "" }))).stdout,
  shims: await Promise.all(["opencode2.cmd", "opencode.cmd"].map(n => readFile(path.join(userPrefix, n)).then(sha, () => null))),
})
const before = await accountState()

// Fake platform binaries: `--version`, and `upgrade <v> --method npm` as OpenCode runs npm.
const fakeSource = path.join(root, "fake.rs")
await writeFile(fakeSource, `fn main() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  match args.first().map(String::as_str) {
    Some("--version") => println!("opencode v{}", env!("FAKE_VERSION")),
    Some("sleep") => std::thread::sleep(std::time::Duration::from_secs(60)),
    Some("upgrade") => {
      let line = format!("npm install --global @opencode/cli@{}", args[1]);
      let status = std::process::Command::new("cmd").args(["/d", "/s", "/c", &line]).status().unwrap();
      std::process::exit(status.code().unwrap_or(1));
    }
    _ => std::process::exit(2),
  }
}\n`)
const fakes = {}
const fake = async version => {
  if (fakes[version]) return fakes[version]
  const exe = path.join(root, `fake-${version}.exe`)
  await run("rustc", ["--edition", "2021", "-C", "opt-level=1", "-o", exe, fakeSource], { env: { ...process.env, FAKE_VERSION: version }, windowsHide: true })
  return (fakes[version] = await readFile(exe))
}

function tarball(entries) {
  const blocks = []
  for (const [name, body] of Object.entries(entries)) {
    const header = Buffer.alloc(512)
    header.write(`package/${name}`, 0)
    for (const [at, value] of [[100, "0000755"], [108, "0000000"], [116, "0000000"], [124, body.length.toString(8).padStart(11, "0")], [136, "00000000000"]]) header.write(value, at)
    header.fill(" ", 148, 156); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263)
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

const registry = await startFakeNpmRegistry()
// `@opencode/cli` 2.3.2's own postinstall (MIT), so npm selects and links the platform binary as it does for real.
const postinstall = await readFile(new URL("./opencode-cli-postinstall.mjs", import.meta.url))
const platforms = ["@opencode/cli-windows-x64", "@opencode/cli-windows-x64-baseline"]
for (const version of ["2.4.0", "2.5.0", "2.6.0"]) {
  const exe = await fake(version)
  const manifest = { bin: { opencode: "./bin/opencode.exe", opencode2: "./bin/opencode.exe" }, scripts: { postinstall: "node ./postinstall.mjs" },
    os: ["darwin", "linux", "win32"], cpu: ["arm64", "x64"], optionalDependencies: Object.fromEntries(platforms.map(p => [p, version])) }
  registry.publish("@opencode/cli", version, tarball({ "package.json": Buffer.from(JSON.stringify({ name: "@opencode/cli", version, license: "MIT", ...manifest }, null, 2)),
    "postinstall.mjs": postinstall, "bin/opencode.exe": Buffer.from("placeholder") }), manifest)
  for (const name of platforms) {
    const platform = { os: ["win32"], cpu: ["x64"] }
    registry.publish(name, version, tarball({ "package.json": Buffer.from(JSON.stringify({ name, version, license: "MIT", ...platform })), "bin/opencode.exe": exe }), platform)
  }
}

// The scoped registry: a token is required, and 2.6.0's platform packages arrive replaced by a valid
// archive with another binary (the registry's integrity no longer matches).
const substitute = tarball({ "package.json": Buffer.from(JSON.stringify({ name: platforms[0], version: "2.6.0" })), "bin/opencode.exe": await fake("9.9.9") })
const token = `bench-${Math.random().toString(36).slice(2)}`
const seen = []
const front = createServer((req, res) => {
  const authorized = req.headers.authorization === `Bearer ${token}`
  seen.push({ path: decodeURIComponent(req.url), authorized })
  if (!authorized) { res.writeHead(401); res.end(); return }
  const upstream = httpRequest(`${registry.url}${req.url}`, { headers: { accept: req.headers.accept ?? "*/*" } }, answer => {
    const chunks = []
    answer.on("data", chunk => chunks.push(chunk))
    answer.on("end", () => {
      let body = Buffer.concat(chunks)
      if (/cli-windows-x64(?:-baseline)?-2\.6\.0\.tgz$/.test(req.url)) body = substitute
      // Tarballs are fetched through this front too.
      if (/json/.test(answer.headers["content-type"] ?? "")) body = Buffer.from(body.toString("utf8").replaceAll(registry.url, scope.slice(0, -1)))
      res.writeHead(answer.statusCode, { "content-type": answer.headers["content-type"] ?? "application/octet-stream" })
      res.end(body)
    })
  })
  upstream.on("error", () => { res.writeHead(502); res.end() })
  upstream.end()
})
await new Promise(resolve => front.listen(0, "127.0.0.1", resolve))
const scope = `http://127.0.0.1:${front.address().port}/`

// A forward HTTP proxy counting what it relays.
const proxied = []
const proxy = createServer((req, res) => {
  proxied.push(req.url)
  const upstream = httpRequest(req.url, { method: req.method, headers: req.headers }, answer => { res.writeHead(answer.statusCode, answer.headers); answer.pipe(res) })
  upstream.on("error", () => { res.writeHead(502); res.end() })
  req.pipe(upstream)
})
await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve))
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`

async function route(side) {
  const password = "bench-route"
  const child = spawn(bin, [side.env.TEMP, path.join(side.env.TEMP, "rust.json"), "0", ""], { env: { ...side.env, CNRS_SERVER_PASSWORD: password }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  for (const s of [child.stdout, child.stderr]) s.on("data", d => { output += d })
  try {
    for (const end = Date.now() + 20000; !/^http:\/\/127\.0\.0\.1:\d+\r?$/m.test(output); await new Promise(r => setTimeout(r, 50))) assert(Date.now() < end && child.exitCode === null, output)
    const origin = output.match(/^(http:\/\/127\.0\.0\.1:\d+)\r?$/m)[1]
    const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "codenomad", password }) })
    const cookie = login.headers.get("set-cookie").split(";")[0]
    const res = await fetch(`${origin}/api/opencode/update`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(300000) })
    const answer = { status: res.status, body: await res.json() }
    if (res.status !== 502) answer.log = output.slice(-3000)
    return answer
  } finally { child.kill() }
}

const system = [path.join(process.env.SystemRoot, "System32"), process.env.SystemRoot, path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0"), path.dirname(process.execPath)].join(";")
/** A private profile; `foreign` puts a non-npm `opencode.exe` of that version first in PATH. */
async function profile(label, name = label, foreign) {
  const home = path.join(root, name)
  const env = { SystemRoot: process.env.SystemRoot, windir: process.env.windir, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    SystemDrive: process.env.SystemDrive, PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE, PROCESSOR_IDENTIFIER: process.env.PROCESSOR_IDENTIFIER,
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: path.join(home, "tmp"), TMP: path.join(home, "tmp"), npm_config_userconfig: path.join(home, ".npmrc"),
    npm_config_cache: path.join(home, "npm-cache"), npm_config_update_notifier: "false", CNRS_FIXTURE_NO_USER_PATH: "1", PATH: system }
  for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.TEMP]) await mkdir(dir, { recursive: true })
  await writeFile(env.npm_config_userconfig, `@opencode:registry=${scope}\n${scope.replace(/^http:/, "")}:_authToken=${token}\n`)
  const prefix = path.join(env.APPDATA, "npm")
  assert(prefix.startsWith(root) && env.npm_config_userconfig.startsWith(root))
  let front = ""
  if (foreign) {
    const dir = path.join(home, "foreign")
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "opencode.exe"), await fake(foreign))
    front = `${dir};`
    env.PATH = front + system
  }
  return { label, env, prefix, home, front }
}

const tsInstall = path.join(root, "ts-install.mjs")
await writeFile(tsInstall, `import { register } from "node:module"
register(new URL("loader.js", ${JSON.stringify(dist.href)}), import.meta.url)
const { installSharedOpenCode, prepareForeignProbe } = await import(new URL("opencode-update/shared-installation.js", ${JSON.stringify(dist.href)}))
// As OpenCodeUpdateService.upgrade: the foreign probe settles first.
await prepareForeignProbe({ env: process.env, home: process.env.USERPROFILE })
try {
  const binary = await installSharedOpenCode(process.argv[2], { env: process.env, home: process.env.USERPROFILE, registerPath: async () => {},
    node: process.execPath, npm: ${JSON.stringify(path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"))} })
  console.log(JSON.stringify({ ok: true, binary }))
} catch (error) { console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 300) })) }
`)
const lastJson = text => JSON.parse(text.trim().split(/\r?\n/).filter(l => l.startsWith("{")).at(-1))
async function act(side, args) {
  const [file, argv] = side.label === "ts" ? [process.execPath, [tsInstall, ...args.slice(1)]] : [bin, ["opencode", ...args]]
  const { stdout } = await run(file, argv, { env: side.env, cwd: side.env.TEMP, windowsHide: true, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }).catch(e => e)
  return lastJson(String(stdout))
}

const discover = path.join(root, "ts-discover.mjs")
await writeFile(discover, `import { register } from "node:module"
register(new URL("loader.js", ${JSON.stringify(dist.href)}), import.meta.url)
const { prepareForeignProbe, resolveDefaultInstallation, sharedInstallationPlan } = await import(new URL("opencode-update/shared-installation.js", ${JSON.stringify(dist.href)}))
const prefix = process.argv[2], host = { env: process.env, home: process.env.USERPROFILE }
const home = process.env.USERPROFILE
const local = value => value?.startsWith(prefix) ? "<prefix>" + value.slice(prefix.length) : value?.startsWith(home) ? "<home>" + value.slice(home.length) : value
// The foreign probe settles before the synchronous reads, as the reference's status read does.
await prepareForeignProbe(host, { force: true })
const found = resolveDefaultInstallation(host), plan = sharedInstallationPlan(host)
const foreign = plan.foreign && { path: local(plan.foreign.command), source: plan.foreign.source, ...(plan.foreign.version ? { version: plan.foreign.version } : {}),
  ...(plan.foreign.blocked ? { blocked: { reason: plan.foreign.blocked.reason, path: local(plan.foreign.blocked.path) } } : {}) }
console.log(JSON.stringify({ path: local(found.path), source: found.source ?? null, plan: local(plan.prefix) ?? null, foreign: foreign ?? null }))
`)
async function observe(side) {
  const shims = {}
  // The extensionless `sh` shim follows the cmd-shim of each npm release: recorded, not compared.
  for (const name of (await readdir(side.prefix).catch(() => [])).filter(n => /^opencode2?(\.cmd|\.ps1)$/.test(n)).sort()) shims[name] = sha(await readFile(path.join(side.prefix, name)))
  const shellShim = await readFile(path.join(side.prefix, "opencode2")).then(sha, () => null)
  const env = { ...side.env, PATH: `${side.front}${side.prefix};${system}` }
  const version = (await run(path.join(side.prefix, "opencode2.cmd"), ["--version"], { env, windowsHide: true, shell: true }).catch(() => ({ stdout: "" }))).stdout.trim() || null
  const discovery = lastJson((await run(process.execPath, [discover, side.prefix], { env, windowsHide: true })).stdout)
  const manifest = await readFile(path.join(side.prefix, "node_modules", "@opencode", "cli", "package.json")).then(sha, () => null)
  const status = lastJson((await run(bin, ["opencode", "status"], { env, windowsHide: true }).catch(e => e)).stdout)
  const local = value => value?.startsWith(side.prefix) ? "<prefix>" + value.slice(side.prefix.length) : value?.startsWith(side.home) ? "<home>" + value.slice(side.home.length) : value
  const f = status.foreignInstallation
  // The same layout through Rust's functions: resolution, plan and the foreign notice.
  const rustView = { path: local(status.resolved.path), source: status.resolved.source, plan: local(status.plan) ?? null,
    foreign: f ? { path: local(f.path), source: f.source, ...(f.version ? { version: f.version } : {}), ...(f.blocked ? { blocked: { reason: f.blocked.reason, path: local(f.blocked.path) } } : {}) } : null }
  assert.deepEqual(rustView, discovery, `${side.label}: Rust and TS read the same layout alike`)
  return { version, discovery, shims, manifest, rustStatus: status.installed?.version ?? null, shellShim }
}

const npmReason = async side => {
  const logs = path.join(side.env.npm_config_cache, "_logs")
  const texts = await Promise.all((await readdir(logs).catch(() => [])).map(n => readFile(path.join(logs, n), "utf8")))
  return texts.some(t => /EINTEGRITY/.test(t)) ? "EINTEGRITY" : "unknown"
}
const result = { binary: bin, steps: {}, reasons: {}, foreign: {} }
try {
  // Foreign OpenCode in PATH: below the minimum, 2 goes beside it and is preferred (the foreign file
  // untouched); a current one keeps its authority and nothing is installed.
  for (const label of ["ts", "rs"]) {
    const steps = result.foreign[label] = {}
    for (const [name, version] of [["superseded", "1.5.0"], ["current", "2.4.0"]]) {
      const side = await profile(label, `${label}-foreign-${name}`, version)
      const foreignFile = path.join(side.home, "foreign", "opencode.exe"), before = sha(await readFile(foreignFile))
      const status = await observe(side)
      const outcome = await act(side, ["install", "2.4.0"])
      steps[name] = { before: status, ok: outcome.ok, error: outcome.ok ? null : outcome.error, after: await observe(side), untouched: sha(await readFile(foreignFile)) === before }
    }
    // A 2.0.14 that runs cannot be replaced: the reference refuses before changing anything.
    const side = await profile(label, `${label}-in-use`)
    assert((await act(side, ["install", "2.4.0"])).ok)
    await writeFile(path.join(side.prefix, "node_modules", "@opencode", "cli", "bin", "opencode.exe"), await fake("2.0.14"))
    const running = spawn(path.join(side.prefix, "node_modules", "@opencode", "cli", "bin", "opencode.exe"), ["sleep"], { windowsHide: true, stdio: "ignore" })
    try {
      const outcome = await act(side, ["install", "2.5.0"])
      steps.inUse = { ok: outcome.ok, error: outcome.ok ? null : outcome.error, after: await observe(side) }
    } finally { running.kill() }
  }
  const strip = ({ shellShim, ...rest }) => rest
  const view = ({ before, after, ...rest }) => ({ ...rest, ...(before ? { before: strip(before) } : {}), after: strip(after) })
  for (const name of ["superseded", "current", "inUse"]) assert.deepEqual(view(result.foreign.rs[name]), view(result.foreign.ts[name]), name)
  assert.equal(result.foreign.rs.superseded.after.discovery.source, "managed")
  assert.equal(result.foreign.rs.superseded.untouched, true)
  assert.equal(result.foreign.rs.current.error, "The PATH executable is not a writable npm installation")
  assert.equal(result.foreign.rs.inUse.error, "The OpenCode executable is in use or not writable")

  for (const side of [await profile("ts"), await profile("rs")]) {
    const steps = result.steps[side.label] = {}
    const step = async (name, args) => {
      const outcome = await act(side, args)
      steps[name] = { ok: outcome.ok, ...await observe(side) }
      // TS hides npm's stderr: its reason is in npm's own log.
      if (!outcome.ok) (result.reasons[side.label] ??= {})[name] = side.label === "rs" ? outcome.code + ": " + outcome.error : await npmReason(side)
    }
    await step("install", ["install", "2.4.0"])
    await step("update", ["install", "2.5.0"])
    await step("tampered", ["install", "2.6.0"])
    if (side.label !== "rs") continue
    await step("rollback", ["rollback"])
    // Update while 2.4.0 runs (its image stays mapped), through an HTTP proxy.
    const running = spawn(path.join(side.prefix, "node_modules", "@opencode", "cli", "bin", "opencode.exe"), ["sleep"], { windowsHide: true, stdio: "ignore" })
    side.env.HTTP_PROXY = proxyUrl
    try { await step("runningUpdate", ["install", "2.5.0"]) } finally { running.kill(); delete side.env.HTTP_PROXY }
    result.proxied = proxied.length
    // The route: latest is the substituted 2.6.0, refused with the reference's body.
    result.route = await route(side)
    steps.afterRoute = await observe(side)
  }
  const comparable = ({ shellShim, ...rest }) => rest
  for (const name of ["install", "update"]) assert.deepEqual(comparable(result.steps.rs[name]), comparable(result.steps.ts[name]), name)
  const { ts, rs } = result.steps
  // Rust refuses the substituted package and keeps 2.5.0.
  assert.equal(rs.tampered.ok, false)
  assert.equal(rs.tampered.version, "opencode v2.5.0")
  assert.match(result.reasons.rs.tampered, /^upgrade_failed: integrity_mismatch/)
  // TS: npm refuses the optional platform packages, then the package's postinstall fallback
  // (`npm install --prefix <temp> <platform>@<version>`) installs the substituted binary, which the
  // version check (at least the target) admits. Recorded so any change of this outcome is seen.
  result.divergences = { tampered: { ts: { ok: ts.tampered.ok, version: ts.tampered.version }, rs: { ok: rs.tampered.ok, version: rs.tampered.version } } }
  assert.equal(ts.tampered.version, "opencode v9.9.9")
  assert.equal(rs.rollback.version, "opencode v2.4.0")
  assert.equal(rs.rollback.discovery.path, "<prefix>\\opencode2.cmd")
  assert.equal(rs.runningUpdate.version, "opencode v2.5.0")
  assert(result.proxied > 0, "the HTTP proxy relayed the registry requests")
  assert.deepEqual(result.route, { status: 502, body: { success: false, error: "upgrade_failed" } })
  assert.equal(rs.afterRoute.version, "opencode v2.5.0")
  assert(seen.length > 0 && seen.every(r => r.authorized), "every registry request carried the token")
  assert.deepEqual(await accountState(), before, "the account's npm prefix and user PATH are unchanged")
  result.ok = true
} catch (error) {
  result.error = String(error?.stack ?? error)
  throw error
} finally {
  front.close(); proxy.close(); await registry.close()
  result.requests = seen.length
  await writeJson("opencode-install.json", result)
}
console.log(JSON.stringify(result, null, 2))
