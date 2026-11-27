// Rust-only regression bench of the security audit findings (Windows): HTTPS admission under idle-socket
// floods (M1), lexical paths and cross-site navigation (M2), Git configuration guard (M3), protected data
// folder (F2), event stream budgets (F3). `node hardening.mjs <opencode executable>`
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { existsSync, realpathSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { assertPrivateOpenCodeExecutable } from "./private-profile.mjs"

export function buildHardeningGitEnv(sourceEnv = process.env, platform = process.platform) {
  const clean = Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => !/^GIT_/i.test(key)))
  return {
    ...clean,
    GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@a",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@a",
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
const rawCli = process.argv[2]
assert(path.isAbsolute(rawCli ?? ""), "usage: node hardening.mjs <absolute opencode executable>")
const cli = await assertPrivateOpenCodeExecutable(rawCli)
const { withProductRuntime } = await import("../../../scripts/native-product-fixture.mjs")
const { fixtureChildPid, spawnFixtureChild: spawn, stopFixtureChild } = await import("../../../scripts/native-fixture-guards.mjs")
const { dropRegistration, out, rustBinary, useBenchTemp, writeJson } = await import("./fixtures.mjs")
const bin = rustBinary()
await useBenchTemp()

const results = []
const failures = []
const note = (id, data, pass) => {
  results.push({ id, pass, ...data })
  if (pass === false) failures.push(id)
  console.log(pass === false ? "FAIL" : "ok  ", id, JSON.stringify(data))
}

function send(base, url, { method = "GET", headers = {}, body, stream = false, ca } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const lib = base.startsWith("https:") ? https : http
    const req = lib.request(base + url, { method, headers, agent: false, timeout: 20000, ca, rejectUnauthorized: !!ca }, res => {
      if (stream) return resolve({ status: res.statusCode, response: res, ms: Date.now() - started })
      let text = ""; res.setEncoding("utf8")
      res.on("data", c => text += c)
      res.on("end", () => { let parsed = text; try { parsed = JSON.parse(text) } catch {}; resolve({ status: res.statusCode, body: parsed, headers: res.headers, ms: Date.now() - started }) })
    })
    req.on("error", reject)
    req.on("timeout", () => req.destroy(Error("timeout")))
    req.end(body)
  })
}

const gitEnv = buildHardeningGitEnv()
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env: gitEnv, windowsHide: true, encoding: "utf8" })

await withProductRuntime(cli, async () => ({}), async ({ root: home, env, connection }) => {
  const projects = path.join(home, "projects")
  const repo = path.join(projects, "repo")
  await mkdir(repo, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  await writeFile(path.join(repo, "a.txt"), "one\n")
  git(repo, "add", "a.txt"); git(repo, "commit", "-q", "-m", "init")
  const password = randomUUID()
  const child = spawn(bin, [projects, path.join(home, "hardening.json"), "0", cli], {
    cwd: home, windowsHide: true,
    env: { ...env, CNRS_FIXTURE_URL: connection.endpoint.url, CNRS_FIXTURE_PASSWORD: connection.endpoint.auth.password,
      CNRS_SERVER_PASSWORD: password, CNRS_HTTPS_BIND: "127.0.0.1:0", CNRS_HTTPS_NAME: "127.0.0.1",
      CNRS_FIXTURE_INGRESS: "1", CNRS_FIXTURE_STDIN_STOP: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" },
  })
  const stopped = new Promise(r => child.once("close", r))
  let lines = ""; for (const s of [child.stdout, child.stderr]) s.on("data", b => lines += b)
  const open = []
  try {
    const end = Date.now() + 20000
    while (!(/^HTTPS https:\/\/127/m.test(lines) && /^http:\/\/127/m.test(lines)) && Date.now() < end && child.exitCode === null) await delay(25)
    const local = /^http:\/\/127\.0\.0\.1:\d+/m.exec(lines)?.[0]
    const remote = /^HTTPS (https:\/\/127\.0\.0\.1:(\d+))/m.exec(lines)
    assert(local && remote, lines)
    const host = local.slice("http://".length)

    // ---- F2: data folder protected from the first start
    const data = path.join(home, "hardening.data")
    const acl = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-Command",
      `$a = Get-Acl -LiteralPath '${data.replaceAll("'", "''")}'; @{ protected = $a.AreAccessRulesProtected; owner = $a.Owner; sids = @($a.Access | % { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }) } | ConvertTo-Json -Compress`],
      { windowsHide: true, encoding: "utf8" }))
    note("F2.data-dacl", acl, acl.protected === true && acl.sids.every(s => s === "S-1-3-4" || s === "S-1-5-18"))

    const login = await send(local, "/api/auth/login", { method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ username: "codenomad", password }) })
    assert.equal(login.status, 200)
    const cookie = login.headers["set-cookie"][0].split(";")[0]
    const H = (extra = {}) => ({ host, cookie, ...extra })
    const M = (extra = {}) => H({ origin: local, "content-type": "application/json", ...extra })
    const created = await send(local, "/api/workspaces", { method: "POST", headers: M(), body: JSON.stringify({ path: "repo" }) })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const id = created.body.id
    for (let i = 0; i < 100; i++) { if ((await send(local, `/api/workspaces/${id}`, { headers: H() })).body?.status === "ready") break; await delay(100) }

    // ---- F3: a new stream starts with the workspace statuses; a paused one is neither cut nor flooded
    const frames = response => {
      const seen = []; let buffer = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { buffer += chunk; let i; while ((i = buffer.indexOf("\n\n")) >= 0) { const data = buffer.slice(0, i).split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n"); buffer = buffer.slice(i + 2); if (data) seen.push(JSON.parse(data)) } })
      return seen
    }
    const connection = { clientId: "slow", connectionId: randomUUID() }
    const streamPath = `/api/events?${new URLSearchParams(connection)}`
    const stream = () => send(local, streamPath, { headers: H({ accept: "text/event-stream" }), stream: true })
    const slow = await stream()
    open.push(slow.response)
    slow.closed = false; slow.response.on("close", () => slow.closed = true)
    const slowFrames = frames(slow.response)
    const connected = seen => seen.find(e => e.type === "instance.eventStatus" && e.instanceId === id && e.status === "connected")
    for (let i = 0; i < 50 && !connected(slowFrames); i++) await delay(100)
    const replayed = connected(slowFrames)
    note("F3.status-replay", { status: replayed?.status }, replayed?.status === "connected")
    slow.response.pause()
    const patches = 60, pad = "x".repeat(100_000)
    for (let i = 0; i < patches; i++) {
      const r = await send(local, "/api/storage/state/ui", { method: "PATCH", headers: M(), body: JSON.stringify({ recentFolders: [`${pad}${i}`] }) })
      assert.equal(r.status, 200, JSON.stringify(r.body))
    }
    slow.response.resume()
    const final = `${pad}${patches - 1}`
    for (let i = 0; i < 50 && !slowFrames.some(e => e.value?.recentFolders?.[0] === final); i++) await delay(100)
    const states = slowFrames.filter(e => e.type === "storage.stateChanged" && e.owner === "ui")
    note("F3.slow-subscriber-folds", { patches, delivered: states.length, closed: slow.closed, last: states.at(-1)?.value?.recentFolders?.[0]?.slice(-2) },
      !slow.closed && states.length > 0 && states.length < patches && states.at(-1).value.recentFolders[0] === final)
    const replacement = await stream()
    open.push(replacement.response)
    const replay = frames(replacement.response)
    for (let i = 0; i < 50 && (!slow.closed || !connected(replay)); i++) await delay(100)
    const pong = await send(local, "/api/client-connections/pong", { method: "POST", headers: M(), body: JSON.stringify(connection) })
    note("F3.reconnect-same-key", { oldClosed: slow.closed, status: connected(replay)?.status, pong: pong.status },
      slow.closed && connected(replay)?.generation === replayed?.generation && pong.status === 204)
    replacement.response.destroy()

    // ---- M2: cross-site navigation with the local cookie
    for (const [site, expected] of [["cross-site", 403], ["same-site", 403], ["same-origin", 200], ["none", 200], [undefined, 200]]) {
      const headers = site ? H({ "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }) : H()
      const r = await send(local, "/api/filesystem", { headers })
      note(`M2.navigation.${site ?? "absent"}`, { status: r.status }, r.status === expected)
    }
    const anonymous = await send(local, "/api/auth/status", { headers: { host, "sec-fetch-site": "cross-site" } })
    note("M2.navigation.cross-site-without-cookie", { status: anonymous.status }, anonymous.status === 200)

    // ---- M2: no route opens a client-chosen device or network path
    const routes = [
      ["filesystem.path", p => ["GET", `/api/filesystem?path=${encodeURIComponent(p)}`]],
      ["files.directory", p => ["GET", `/api/workspaces/${id}/files?directory=${encodeURIComponent(p)}`]],
      ["files.path", p => ["GET", `/api/workspaces/${id}/files?path=${encodeURIComponent(p)}`]],
      ["files.preview.directory", p => ["GET", `/api/workspaces/${id}/files/preview?path=a.txt&directory=${encodeURIComponent(p)}`]],
      ["files.put.directory", p => ["PUT", `/api/workspaces/${id}/files/content?path=a.txt&directory=${encodeURIComponent(p)}`, { contents: "x" }]],
      ["workspaces.create.path", p => ["POST", "/api/workspaces", { path: p }]],
      ["relay.directory", p => ["GET", `/workspaces/${id}/instance/api/agent?directory=${encodeURIComponent(p)}`]],
      ["relay.location", p => ["GET", `/workspaces/${id}/instance/api/agent?${encodeURIComponent("location[directory]")}=${encodeURIComponent(p)}`]],
      ["git-init.directory", p => ["POST", `/api/workspaces/${id}/git-init`, { directory: p }]],
      ["subagent-depth.get", p => ["GET", `/api/workspaces/${id}/subagent-depth?directory=${encodeURIComponent(p)}`]],
      ["subagent-depth.put", p => ["PUT", `/api/workspaces/${id}/subagent-depth`, { location: { directory: p }, depth: null, expectation: "0".repeat(64) }]],
    ]
    for (const [label, make] of routes) {
      for (const spelling of ["\\\\.\\pipe\\", "//./pipe/", "\\\\?\\pipe\\"]) {
        const name = `cnrs-hardening-${randomUUID()}`
        let opened = 0
        const server = net.createServer(s => { opened++; s.destroy() })
        await new Promise(r => server.listen(`\\\\.\\pipe\\${name}`, r))
        const [method, url, body] = make(spelling + name)
        const res = await send(local, url, { method, headers: body ? M() : H(), body: body && JSON.stringify(body) })
        await delay(150)
        server.close()
        note(`M2.device-open.${label}.${spelling.replaceAll("\\", "b").replaceAll("/", "s").replace("?", "q")}`, { status: res.status, pipeConnections: opened }, opened === 0 && res.status >= 400)
      }
    }
    // A legitimate absolute directory still works.
    const legitDirectory = await send(local, `/api/workspaces/${id}/files?directory=${encodeURIComponent(created.body.path)}`, { headers: H() })
    note("M2.legit-directory", { status: legitDirectory.status }, legitDirectory.status === 200)
    const legitBrowse = await send(local, `/api/filesystem?path=repo`, { headers: H() })
    note("M2.legit-browse", { status: legitBrowse.status }, legitBrowse.status === 200)

    // ---- M3: Git configuration guard (passive reads; explicit mutations follow
    // normal Git configuration for parity with `git-mutations.ts`, e.g. local LFS filters)
    const marker = path.join(home, "filter-ran.txt")
    const filterCmd = `touch '${marker.replaceAll("\\", "/")}'; cat`
    const gitRoutes = {
      status: () => send(local, `/api/workspaces/${id}/worktrees/root/git-status`, { headers: H() }),
      diff: () => send(local, `/api/workspaces/${id}/worktrees/root/git-diff?path=a.txt&scope=unstaged`, { headers: H() }),
      history: () => send(local, `/api/workspaces/${id}/worktrees/root/git-history`, { headers: H() }),
    }
    const baseline = await gitRoutes.status()
    note("M3.baseline", { status: baseline.status }, baseline.status === 200)
    const refusedEverywhere = async label => {
      for (const [name, call] of Object.entries(gitRoutes)) {
        await rm(marker, { force: true })
        const r = await call()
        note(`M3.${label}.${name}`, { status: r.status, filterRan: existsSync(marker), error: r.body?.error }, r.status === 403 && !existsSync(marker))
      }
    }
    await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=audit\n")
    git(repo, "config", "filter.audit.clean", filterCmd)
    await writeFile(path.join(repo, "a.txt"), "two\n")
    await refusedEverywhere("local-config")
    git(repo, "config", "--unset", "filter.audit.clean")
    git(repo, "config", "core.repositoryformatversion", "1")
    git(repo, "config", "extensions.worktreeConfig", "true")
    git(repo, "config", "--worktree", "filter.audit.clean", filterCmd)
    await writeFile(path.join(repo, "a.txt"), "three\n")
    await refusedEverywhere("worktree-config")
    git(repo, "config", "--worktree", "--unset", "filter.audit.clean")
    git(repo, "config", "--unset", "extensions.worktreeConfig")
    git(repo, "config", "core.repositoryformatversion", "0")
    await rm(path.join(repo, ".git", "config.worktree"), { force: true })
    await rm(path.join(repo, ".gitattributes"), { force: true })
    const restored = await gitRoutes.status()
    note("M3.restored", { status: restored.status }, restored.status === 200)
    // Submodule variant: a filter in the submodule's own configuration.
    const source = path.join(home, "subsource")
    await mkdir(source)
    git(source, "init", "-q", "-b", "main")
    await writeFile(path.join(source, "s.txt"), "s\n")
    git(source, "add", "s.txt"); git(source, "commit", "-q", "-m", "s")
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub")
    git(repo, "commit", "-q", "-m", "sub")
    const moduleDir = path.join(repo, ".git", "modules", "sub")
    const benign = await gitRoutes.status()
    note("M3.submodule.benign", { status: benign.status }, benign.status === 200)
    git(moduleDir, "config", "filter.audit.clean", filterCmd)
    await writeFile(path.join(repo, "sub", ".gitattributes"), "*.txt filter=audit\n")
    await writeFile(path.join(repo, "sub", "s.txt"), "changed\n")
    await writeFile(path.join(repo, "a.txt"), "four\n")
    await refusedEverywhere("submodule-config")
    // Control: plain Git in the superproject does run the submodule filter.
    await rm(marker, { force: true })
    try { git(repo, "diff", "--submodule=diff") } catch {}
    note("M3.submodule.control-plain-git-runs-filter", { filterRan: existsSync(marker) }, existsSync(marker))
    // Embedded repository (Git directory inside the work tree, not scanned):
    // the superproject's reads never run Git in it.
    git(moduleDir, "config", "--unset", "filter.audit.clean")
    await rm(path.join(repo, "sub", ".gitattributes"), { force: true })
    git(path.join(repo, "sub"), "checkout", "-q", "--", "s.txt")
    const embedded = path.join(repo, "embedded")
    await mkdir(embedded)
    git(embedded, "init", "-q", "-b", "main")
    await writeFile(path.join(embedded, ".gitattributes"), "*.txt filter=audit\n")
    await writeFile(path.join(embedded, "e.txt"), "aaaa\n")
    git(embedded, "add", "."); git(embedded, "commit", "-q", "-m", "e")
    git(embedded, "config", "filter.audit.clean", filterCmd)
    try { git(repo, "add", "embedded") } catch {}
    git(repo, "commit", "-q", "-m", "embedded")
    await delay(1100)
    await writeFile(path.join(embedded, "e.txt"), "bbbb\n")
    await rm(marker, { force: true })
    const embeddedStatus = await gitRoutes.status()
    const embeddedDiff = await gitRoutes.diff()
    note("M3.embedded.status-and-diff", { status: embeddedStatus.status, diff: embeddedDiff.status, filterRan: existsSync(marker) }, embeddedStatus.status === 200 && !existsSync(marker))
    await rm(marker, { force: true })
    try { git(repo, "diff", "--name-status") } catch {}
    note("M3.embedded.control-plain-git-runs-filter", { filterRan: existsSync(marker) }, existsSync(marker))

    // ---- M1 / F3: HTTPS admission
    const port = Number(remote[2])
    const tlsBase = remote[1]
    const issued = await send(local, "/api/remote-control/pairings", { method: "POST", headers: M() })
    assert.equal(issued.status, 200, JSON.stringify(issued.body))
    const code = new URL(issued.body.url).hash.slice(1)
    const pairing = await send(tlsBase, "/api/remote-control/server-pair", { method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "x-codenomad-server-pairing": "1" },
      body: JSON.stringify({ code, hostName: "Hardening" }) })
    assert.equal(pairing.status, 200, JSON.stringify(pairing.body))
    const device = { host: `127.0.0.1:${port}`, cookie: `__Host-codenomad_device=${pairing.body.credential}`, "x-codenomad-server-request": "1" }
    const paired = () => send(tlsBase, "/api/meta", { headers: device })
    const mute = () => new Promise(resolve => {
      const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => resolve(s))
      s.on("error", () => {}); open.push(s)
    })
    const rawMute = () => new Promise(resolve => { const s = net.connect(port, "127.0.0.1", () => resolve(s)); s.on("error", () => {}); open.push(s) })
    const before = await paired()
    note("M1.paired.before", { status: before.status, ms: before.ms }, before.status === 200)
    // Eight device event streams (the device budget) stay open through the flood.
    const streams = []
    for (let i = 0; i < 8; i++) {
      const r = await send(tlsBase, `/api/events?clientId=device&connectionId=s${i}`, { headers: { ...device, accept: "text/event-stream" }, stream: true })
      r.closed = false; r.response.on("close", () => r.closed = true); r.response.resume()
      streams.push(r)
    }
    note("F3.device-streams", { statuses: streams.map(s => s.status) }, streams.every(s => s.status === 200))
    const ninth = await send(tlsBase, `/api/events?clientId=device&connectionId=s8`, { headers: { ...device, accept: "text/event-stream" }, stream: true })
    ninth.response.resume()
    note("F3.device-budget", { status: ninth.status }, ninth.status === 503)
    const localStream = await send(local, `/api/events?clientId=device&connectionId=s0`, { headers: H({ accept: "text/event-stream" }), stream: true })
    localStream.response.resume(); localStream.response.on("close", () => localStream.closed = true)
    await delay(300)
    note("F3.local-budget-separate", { status: localStream.status, deviceStreamReplaced: streams[0].closed }, localStream.status === 200 && !streams[0].closed)
    const idle = []
    for (let i = 0; i < 32; i++) idle.push(await mute())
    const during = await paired()
    note("M1.paired.during-32-idle-tls", { status: during.status, ms: during.ms, heldSockets: idle.length }, during.status === 200 && during.ms < 1000)
    const pairingPage = await send(tlsBase, "/api/auth/status", { headers: { host: `127.0.0.1:${port}` } })
    note("M1.anonymous.during-32-idle-tls", { status: pairingPage.status, ms: pairingPage.ms }, pairingPage.status === 200 && pairingPage.ms < 1000)
    note("M1.device-streams-kept", { closed: streams.filter(s => s.closed).length }, streams.every(s => !s.closed))
    for (const s of idle) s.destroy()
    const raw = []
    for (let i = 0; i < 32; i++) raw.push(await rawMute())
    const duringRaw = await paired()
    note("M1.paired.during-32-raw-tcp", { status: duringRaw.status, ms: duringRaw.ms }, duringRaw.status === 200 && duringRaw.ms < 1000)
    for (const s of raw) s.destroy()
    // A lone silent socket is closed after the short delays.
    const closeAfter = socket => new Promise(resolve => { const t0 = Date.now(); socket.once("close", () => resolve(Date.now() - t0)) })
    const t1 = closeAfter(await mute())
    const t2 = closeAfter(await rawMute())
    const [tlsClosed, rawClosed] = await Promise.all([t1, t2])
    note("M1.silent-tls-closed", { ms: tlsClosed }, tlsClosed >= 8000 && tlsClosed <= 13000)
    note("M1.silent-tcp-closed", { ms: rawClosed }, rawClosed >= 4000 && rawClosed <= 7000)
    note("M1.device-streams-after-idle", { closed: streams.filter(s => s.closed).length }, streams.every(s => !s.closed))
    for (const s of streams) s.response.destroy()
    localStream.response.destroy()
  } finally {
    for (const s of open) s.destroy()
    child.stdin.write("shutdown\n")
    const pid = await fixtureChildPid(child)
    await stopFixtureChild(child, stopped)
    await dropRegistration(env, pid)
    await writeJson("hardening.json", { binary: bin, failures, results })
    await writeFile(path.join(out, "hardening-rs.log"), lines)
  }
}).catch(error => { failures.push(String(error.stack)); console.error(error); process.exitCode = 1 })
if (failures.length) { console.error("FAILURES", failures); process.exitCode = 1 }
else console.log(`hardening: ${results.length} checks passed`)
}
