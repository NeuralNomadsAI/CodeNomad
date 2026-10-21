import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const entry = fileURLToPath(new URL("../index.ts", import.meta.url))

// The real entry point as a standalone server (no desktop host), with the default
// HTTPS-only listener. No OpenCode is started: only listener and bridge setup run.
test("a standalone HTTPS server publishes a private loopback bridge for Missions and removes it on shutdown", { timeout: 90_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-standalone-bridge-"))
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^(CODENOMAD_|CLI_|OPENCODE_|XDG_)/i.test(key)) env[key] = value
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root })
  const child = spawn(process.execPath, ["--import", "tsx", entry, "--host", "127.0.0.1", "--https", "true", "--http", "false",
    "--config", path.join(root, "config", "config.yaml"), "--workspace-root", root, "--ui-no-update", "--dangerously-skip-auth"],
  { cwd: path.dirname(entry), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  let output = ""
  child.stdout.on("data", chunk => { output += chunk })
  child.stderr.on("data", chunk => { output += chunk })
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)))
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await exited
    await rm(root, { recursive: true, force: true })
  })

  const deadline = Date.now() + 60_000
  while (!/Local Connection URL : https:\/\//.test(output)) {
    assert.ok(child.exitCode === null, `server exited early:\n${output}`)
    assert.ok(Date.now() < deadline, `server did not start:\n${output}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const httpsPort = Number(/Local Connection URL : https:\/\/[^:]+:(\d+)/.exec(output)?.[1])

  const directory = process.platform === "win32"
    ? path.join(root, "CodeNomad", "automation-bridges")
    : path.join(root, "codenomad", "automation-bridges")
  let names: string[] = []
  while (Date.now() < deadline && !(names = await readdir(directory).catch(() => [])).some(name => name.endsWith(".json"))) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const registrations = names.filter(name => name.endsWith(".json"))
  assert.equal(registrations.length, 1, `one bridge registration:\n${output}`)
  const registration = JSON.parse(await readFile(path.join(directory, registrations[0]), "utf8")) as { url: string; token: string }
  const bridge = new URL(registration.url)
  assert.equal(bridge.protocol, "http:")
  assert.equal(bridge.hostname, "127.0.0.1")
  assert.notEqual(Number(bridge.port), httpsPort, "the bridge uses its own private listener, not the visible HTTPS one")
  assert.doesNotMatch(output, /Local Connection URL : http:\/\//, "the private listener is not announced")

  // The private listener only admits the authenticated bridge (no OpenCode call is reached).
  const post = (headers: Record<string, string>) => fetch(bridge, { method: "POST",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ mode: "unknown" }) })
  assert.equal((await post({})).status, 401)
  assert.equal((await post({ "x-codenomad-automation-token": registration.token })).status, 400)

  child.stdin.write("codenomad:shutdown\n")
  assert.equal(await exited, 0, output)
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".json")), [], "shutdown removes the registration")
})
