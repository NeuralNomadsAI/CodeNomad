import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"

const entry = fileURLToPath(new URL("../index.ts", import.meta.url))

// The real entry point as a standalone server with an administrator policy in its environment.
async function launch(t: TestContext, policy: Record<string, string>, args: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-network-policy-"))
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^(CODENOMAD_|CLI_|OPENCODE_|XDG_)/i.test(key)) env[key] = value
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root }, policy)
  const child = spawn(process.execPath, ["--import", "tsx", entry, ...args, "--config", path.join(root, "config", "config.yaml"),
    "--workspace-root", root, "--ui-no-update", "--dangerously-skip-auth"], { cwd: path.dirname(entry), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  let output = ""
  child.stdout.on("data", chunk => { output += chunk })
  child.stderr.on("data", chunk => { output += chunk })
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)))
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await exited
    await rm(root, { recursive: true, force: true })
  })
  return { child, exited, output: () => output }
}

test("an administrator policy locks the listening address and disables Remote Control in the real server", { timeout: 90_000 }, async t => {
  const server = await launch(t, { CODENOMAD_LOCKED_HOST: "127.0.0.1", CODENOMAD_REMOTE_CONTROL: "disabled" },
    ["--host", "0.0.0.0", "--https", "false", "--http", "true", "--http-port", "0"])
  const deadline = Date.now() + 60_000
  let announced: RegExpExecArray | null
  while (!(announced = /Local Connection URL : http:\/\/(.+):(\d+)/.exec(server.output()))) {
    assert.ok(server.child.exitCode === null, `server exited early:\n${server.output()}`)
    assert.ok(Date.now() < deadline, `server did not start:\n${server.output()}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // --host 0.0.0.0 was requested; the administrator's loopback address is what listens.
  assert.equal(announced[1], "127.0.0.1")
  const base = `http://127.0.0.1:${announced[2]}`
  const meta = await (await fetch(`${base}/api/meta`)).json() as { host: string; listeningMode: string; listeningLocked?: boolean }
  assert.deepEqual({ host: meta.host, listeningMode: meta.listeningMode, listeningLocked: meta.listeningLocked },
    { host: "127.0.0.1", listeningMode: "local", listeningLocked: true })

  const start = await fetch(`${base}/api/remote-control/start`, { method: "POST" })
  assert.equal(start.status, 403)
  assert.deepEqual(await start.json(), { error: "Remote Control is disabled by the administrator", code: "remote_control_disabled" })
  const status = await (await fetch(`${base}/api/remote-control/status`)).json() as { disabledByAdministrator?: boolean; state: string }
  assert.deepEqual({ disabled: status.disabledByAdministrator, state: status.state }, { disabled: true, state: "stopped" })

  server.child.stdin.write("codenomad:shutdown\n")
  assert.equal(await server.exited, 0, server.output())
})

test("an unknown Remote Control policy value refuses startup", { timeout: 90_000 }, async t => {
  const server = await launch(t, { CODENOMAD_REMOTE_CONTROL: "off" }, ["--https", "false", "--http", "true", "--http-port", "0"])
  assert.notEqual(await server.exited, 0)
  assert.match(server.output(), /CODENOMAD_REMOTE_CONTROL accepts only "disabled"/)
  assert.doesNotMatch(server.output(), /Local Connection URL/)
})
