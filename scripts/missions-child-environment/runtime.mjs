import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { clearFixtureGitEnvironment } from "../native-fixture-guards.mjs"

// The CLI is the first argument; otherwise the user's shared npm installation on Windows.
export const ASSIGNED_CLI = path.resolve(process.argv[2]
  ?? path.join(process.env.APPDATA ?? os.homedir(), "npm/node_modules/@opencode/cli/bin/opencode.exe"))
export async function privateRoot(cli) {
  assert.equal(path.resolve(cli).toLowerCase(), path.resolve(ASSIGNED_CLI).toLowerCase(), "Only assigned private serve CLI")
  const temp = path.join(os.tmpdir(), "opencode")
  await mkdir(temp, { recursive: true })
  const root = await mkdtemp(path.join(temp, "missions-child-environment-"))
  const config = path.join(root, "config"), project = path.join(root, "project")
  for (const directory of [config, project]) await mkdir(directory)
  clearFixtureGitEnvironment()
  for (const key of Object.keys(process.env)) if (/^(OPENCODE_|CODENOMAD_|XDG_)/i.test(key)) delete process.env[key]
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
  Object.assign(process.env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, OPENCODE_TEST_HOME: root,
    XDG_RUNTIME_DIR: root, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: path.join(root, "fixture.db"),
    OPENCODE_SERVER_PASSWORD: randomUUID(), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FFF: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig-empty"), CHILD_ENV_MARKER: "base" })
  delete process.env.WSL_DISTRO_NAME
  await writeFile(process.env.GIT_CONFIG_GLOBAL, "")
  await writeFile(path.join(config, "opencode.json"), "{}\n")
  execFileSync("git", ["init", project], { windowsHide: true, stdio: "pipe" })
  return { root, config, project }
}

export async function launch(cli, root, environment, deadline) {
  let logs = "", failure
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: environment, windowsHide: true })
  const closed = new Promise(resolve => child.once("close", resolve))
  child.once("error", error => { failure = error })
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { logs = (logs + data).slice(-2 * 1024 * 1024) })
  const watchdog = setTimeout(() => child.kill(), Math.max(1, deadline - Date.now()))
  watchdog.unref()
  const stop = async () => { clearTimeout(watchdog); if (child.exitCode === null) child.kill(); await closed }
  try {
    const startDeadline = Math.min(deadline, Date.now() + 30_000)
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(logs)) {
      if (failure) throw failure
      if (child.exitCode !== null || Date.now() > startDeadline) throw new Error("Assigned private serve failed to start")
      await delay(50)
    }
    const url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${environment.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` }
    const client = OpenCode.make({ baseUrl: url, headers })
    const info = await client.server.info({ signal: AbortSignal.timeout(10_000) })
    assert.equal(info.version, "2.0.21", "Qualify exactly the assigned 2.0.21 runtime")
    return { child, closed, url, client, info, stop, headers, get logs() { return logs } }
  } catch (error) { await stop(); throw error }
}

export async function launchSentinel(cli, root, deadline) {
  const directory = path.join(root, "sentinel")
  await mkdir(directory)
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    OPENCODE_TEST_HOME: directory, OPENCODE_CONFIG_DIR: directory, OPENCODE_DB: path.join(directory, "sentinel.db"),
    OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_SERVER_PASSWORD: randomUUID(), XDG_RUNTIME_DIR: directory }
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(directory, key)
  return launch(cli, directory, env, deadline)
}
