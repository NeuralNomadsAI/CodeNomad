import test from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HostStorage } from "./storage"
import { HostLifetimeClient } from "./client"
import { BackendProcess } from "./backend"
import { canonicalScope } from "./protocol"
import { fixtureStoragePolicy } from "./test-fixture"

const fullFixture = fileURLToPath(new URL("./full-backend-fixture.ts", import.meta.url))
const backendEntry = fileURLToPath(new URL("./backend-entry.ts", import.meta.url))
const actualIndex = fileURLToPath(new URL("../index.ts", import.meta.url))
const temporaryRoot = process.platform === "win32" ? "C:/Users/Admin/AppData/Local/Temp/opencode" : tmpdir()

async function isolate(): Promise<{ root: string; env: NodeJS.ProcessEnv; args: string[] }> {
  const root = await mkdtemp(path.join(temporaryRoot, "host-full-backend-"))
  await chmod(root, 0o700)
  for (const folder of ["home", "config", "data", "state", "cache", "runtime", "local", "hosts", "profile", "ui", "workspaces", "native"])
    await mkdir(path.join(root, folder), { mode: 0o700 })
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(CODENOMAD|CLI_|OPENCODE|XDG_|WSL_|HOME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$|APPDATA$|LOCALAPPDATA$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
  Object.assign(env, { HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    APPDATA: path.join(root, "config"), LOCALAPPDATA: path.join(root, "local"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_RUNTIME_DIR: path.join(root, "runtime"),
    CODENOMAD_UPDATE_CHANNEL: "stable", OPENCODE_CONFIG: path.join(root, "native", "opencode.json") })
  await writeFile(path.join(root, "native", "opencode.json"), JSON.stringify({ provider: {} }))
  // No native workspace is opened. Even accidental default-binary resolution is
  // confined to a private invalid executable, never an installed/shared CLI.
  await writeFile(path.join(root, "profile", "config.yaml"), `server:\n  opencodeBinary: ${JSON.stringify(path.join(root, "native", "forbidden-cli"))}\n`)
  await writeFile(path.join(root, "ui", "index.html"), "<!doctype html><title>private fixture</title>")
  const args = ["serve", "--config", path.join(root, "profile", "config.yaml"),
    "--workspace-root", path.join(root, "workspaces"), "--host", "127.0.0.1",
    "--https", "false", "--http", "true", "--http-port", "0", "--generate-token",
    "--auth-cookie-name", "host_full_fixture", "--ui-dir", path.join(root, "ui"), "--ui-no-update",
    "--log-level", "info", "--log-destination", path.join(root, "backend.log")]
  return { root, env, args }
}
async function installPrivateServiceEntry(root: string): Promise<void> {
  // The wrapper imports this narrowly injected entry, which executes the REAL
  // index main/server/AuthManager. Every service operation throws and records an
  // attempt; its only successful operation releases client-side shutdown state.
  await writeFile(path.join(root, "profile", "package.json"), '{"type":"module"}')
  await writeFile(path.join(root, "profile", "index.ts"), `
import { appendFile, writeFile } from "node:fs/promises"
import { HOST_BACKEND_ENTRY_VERSION, runBackendMain as run } from ${JSON.stringify(pathToFileURL(actualIndex).href)}
export { HOST_BACKEND_ENTRY_VERSION }
const reject = async () => { await appendFile(${JSON.stringify(path.join(root, "native-attempts"))}, "unexpected-service-operation\\n"); throw new Error("private native service forbidden") }
const service = { endpoint: reject, client: reject, headers: reject, validateLocation: reject,
  evictLocation: reject, subscribe: reject, acquire: reject, fetch: reject,
  shutdown: async () => { await writeFile(${JSON.stringify(path.join(root, "service-released"))}, "client-only\\n") } }
export async function runBackendMain(argv: string[]) {
  await appendFile(${JSON.stringify(path.join(root, "main-invocations"))}, "entry\\n")
  const first = run(argv, { sharedService: service })
  const duplicate = run(argv, { sharedService: service })
  if (first !== duplicate) throw new Error("duplicate startup was not fenced")
  await first
}
`)
}
async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("private child exit timeout")), 10_000)
    child.once("exit", () => { clearTimeout(timer); resolve() })
  })
}
async function get(origin: string, route: string, cookie?: string): Promise<any> {
  const response = await fetch(`${origin}${route}`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(5_000) })
  assert.equal(response.status, 200)
  return response.json()
}
async function exchange(origin: string, token: string): Promise<{ status: number; cookie: string | null }> {
  const response = await fetch(`${origin}/api/auth/token`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }), signal: AbortSignal.timeout(5_000) })
  await response.arrayBuffer()
  return { status: response.status, cookie: response.headers.get("set-cookie") }
}

test("full backend IPC readiness, real auth exchanges, detach continuity and graceful profile-only stop", { timeout: 120_000 }, async () => {
  const { root, env, args } = await isolate()
  await installPrivateServiceEntry(root)
  const scope = canonicalScope("stable", path.join(root, "profile", "config.yaml"), root, root)
  const storage = new HostStorage(path.join(root, "hosts"), scope, fixtureStoragePolicy)
  const children: ChildProcess[] = []
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env, stdio: "ignore", windowsHide: true })
  await writeFile(path.join(root, "daemon-sentinel"), "externally-owned\n")
  const launch = async () => {
    const child = spawn(process.execPath, ["--import", "tsx", fullFixture, "manager", root, ...args],
      { env, cwd: process.cwd(), stdio: "ignore", windowsHide: true })
    children.push(child)
  }
  let last: HostLifetimeClient | undefined
  try {
    const [first, second] = await Promise.all([HostLifetimeClient.attach({ storage, launch, deadlineMs: 60_000 }),
      HostLifetimeClient.attach({ storage, launch, deadlineMs: 60_000 })])
    last = first
    assert.equal(first.attachment.origin, second.attachment.origin)
    assert.equal(first.attachment.backendPid, second.attachment.backendPid)
    const origin = first.attachment.origin
    assert.equal((await get(origin, "/api/auth/status")).authenticated, false)
    const [one, two] = await Promise.all([exchange(origin, first.attachment.bootstrapProof), exchange(origin, second.attachment.bootstrapProof)])
    assert.equal(one.status, 200); assert.equal(two.status, 200)
    assert.match(one.cookie!, /^host_full_fixture=/)
    assert.ok(one.cookie!.includes("HttpOnly") && one.cookie!.includes("SameSite=Lax"))
    assert.notEqual(one.cookie, two.cookie)
    const cookie = one.cookie!.split(";")[0]
    assert.equal((await get(origin, "/api/auth/status", cookie)).authenticated, true)
    assert.equal((await exchange(origin, first.attachment.bootstrapProof)).status, 401)
    const meta = await get(origin, "/api/meta", cookie)
    assert.equal(meta.workspaceRoot, path.join(root, "workspaces"))
    assert.deepEqual(await get(origin, "/api/workspaces", cookie), [])
    const unused = await HostLifetimeClient.attach({ storage, launch })
    await unused.detach()
    assert.equal((await exchange(origin, unused.attachment.bootstrapProof)).status, 401, "detach revokes unused actual AuthManager proof")
    await first.detach(); await second.detach()
    const headless = await first.status()
    assert.equal(headless.automationAvailable, false)
    assert.equal(headless.backendPid, first.attachment.backendPid)
    assert.equal(headless.generation, first.attachment.generation)
    assert.equal((await get(origin, "/api/auth/status", cookie)).authenticated, true)
    last = await HostLifetimeClient.attach({ storage, launch })
    assert.equal(last.attachment.origin, origin)
    assert.equal(last.attachment.backendPid, first.attachment.backendPid)
    assert.deepEqual(await last.stopAuthority(), { stopped: true })
    await Promise.all(children.map(waitExit))
    assert.equal(await storage.registration(), undefined)
    assert.equal(await readFile(path.join(root, "service-released"), "utf8"), "client-only\n")
    await assert.rejects(readFile(path.join(root, "native-attempts")), { code: "ENOENT" })
    assert.equal(await readFile(path.join(root, "main-invocations"), "utf8"), "entry\n")
    const logs = await readFile(path.join(root, "backend.log"), "utf8")
    assert.equal(logs.match(/Starting CodeNomad CLI server/g)?.length, 1)
    assert.ok(logs.includes("Shutdown complete"))
    assert.ok(!logs.includes(first.attachment.bootstrapProof) && !logs.includes(cookie))
    assert.equal(sentinel.exitCode, null)
    assert.equal(await readFile(path.join(root, "daemon-sentinel"), "utf8"), "externally-owned\n")
  } catch (error) {
    const logs = await readFile(path.join(root, "backend.log"), "utf8").catch(() => "")
    // Initialization-only diagnostic: never print bodies, tokens or environment.
    for (const line of logs.trim().split("\n")) {
      try { const value = JSON.parse(line); if (value.err) console.error(value.msg, value.err.message) } catch { /* not JSON */ }
    }
    throw error
  } finally {
    await last?.stopAuthority().catch(() => undefined)
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    sentinel.kill()
    await Promise.all(children.map(child => waitExit(child).catch(() => undefined)))
    await waitExit(sentinel)
    await rm(root, { recursive: true, force: true })
  }
})

test("wrapper rejects skip-auth, missing bootstrap and old managed entries before profile mutation", { timeout: 60_000 }, async () => {
  const { root, env, args } = await isolate()
  try {
    const cases = [
      { entry: actualIndex, args: [...args, "--dangerously-skip-auth"] },
      { entry: actualIndex, args: args.filter(arg => arg !== "--generate-token") },
      { entry: path.join(root, "profile", "index.ts"), args },
      { entry: path.join(root, "profile", "bin.ts"), args },
      { entry: actualIndex, args, direct: true },
    ]
    await writeFile(path.join(root, "profile", "index.ts"), "export const oldManagedEntry = true\n")
    await writeFile(path.join(root, "profile", "bin.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path.join(root, "unsafe-import"))}, "must-not-run")`)
    for (const item of cases) {
      const backend = new BackendProcess({ file: process.execPath, args: ["--import", "tsx", item.direct ? actualIndex : backendEntry, ...item.args], cwd: process.cwd(),
        env: { ...env, CODENOMAD_HOST_BACKEND_ENTRY: item.entry } }, async () => { throw new Error("native must never run") })
      await assert.rejects(backend.ready, /backend-exited/)
      await waitExit(backend.child)
      assert.equal(backend.child.exitCode, 1)
    }
    await assert.rejects(readFile(path.join(root, "profile", "auth.json")), { code: "ENOENT" })
    await assert.rejects(readFile(path.join(root, "unsafe-import")), { code: "ENOENT" })
    // Existing standalone CLI direct-entry guard still runs Commander normally.
    const cli = spawn(process.execPath, ["--import", "tsx", actualIndex, "--version"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let output = ""
    cli.stdout!.on("data", chunk => { output += chunk.toString() })
    await waitExit(cli)
    assert.equal(cli.exitCode, 0)
    assert.match(output.trim(), /^\d+\.\d+\.\d+/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("profile stop refuses missing/incomplete cleanup handshakes and nonzero child exit", { timeout: 30_000 }, async () => {
  const { root, env } = await isolate()
  try {
    for (const [marker, code] of [["", 0], ["incomplete", 0], ["complete", 1]] as const) {
      // Private protocol failure child only, not a full-backend substitute.
      const childCode = `
        process.on("message", () => {});
        process.stdin.on("data", () => {
          ${marker ? `process.stdout.write("CODENOMAD_SHUTDOWN_STATUS:${marker}\\n");` : ""}
          process.exit(${code});
        });
        process.send({ host: 1, ready: true, origin: "http://127.0.0.1:1" });
      `
      const backend = new BackendProcess({ file: process.execPath, args: ["-e", childCode], cwd: root, env },
        async () => { throw new Error("no native requests expected") })
      try {
        await backend.ready
        await assert.rejects(backend.stop(), /backend-stop-unconfirmed/)
        await waitExit(backend.child)
      } finally {
        if (backend.child.exitCode === null && backend.child.signalCode === null) backend.child.kill()
        await waitExit(backend.child)
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
