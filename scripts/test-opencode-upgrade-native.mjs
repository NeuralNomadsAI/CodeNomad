// Run with: node --import tsx scripts/test-opencode-upgrade-native.mjs
// Real npm + native CLI, isolated home/prefix/service. Never uses the shared daemon.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, copyFile, writeFile, open } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { installSharedOpenCode, npmExecutable } from "../packages/server/src/opencode-update/shared-installation.ts"
import { executeNpm, openCodeAllowScripts } from "../packages/server/src/opencode-update/npm-runtime.ts"
import { fixtureRuntime } from "./opencode-fixture-runtime.mjs"
import { RECOMMENDED_OPENCODE_VERSION } from "../packages/server/src/opencode/runtime-support.ts"
import { HostOpenCodeService } from "../packages/server/src/workspaces/host-opencode-service.ts"
import { runtimeIdentity } from "../packages/server/src/opencode/compatibility/runtime.ts"

const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-native-upgrade-"))
const selected = await fixtureRuntime(root)
const { node, npm } = selected
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(OPENCODE_|CODENOMAD_|CLI_|XDG_|npm_|PATH$|NODE_|ELECTRON_|WEBVIEW2_)/i.test(key)))
Object.assign(env, {
  HOME: root, USERPROFILE: root, APPDATA: path.join(root, "AppData"), LOCALAPPDATA: path.join(root, "LocalAppData"),
  XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"), OPENCODE_TEST_HOME: root, OPENCODE_CONFIG_DIR: path.join(root, "opencode"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_CONTENT: "{}",
  npm_config_prefix: path.join(root, "npm prefix"), npm_config_cache: path.join(root, "npm-cache"),
  npm_config_userconfig: path.join(root, "npmrc"),
  ...selected.env, PATH: selected.path,
})
for (const key of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG_DIR"]) {
  await mkdir(env[key], { recursive: true })
}
const binary = npmExecutable(env.npm_config_prefix)
const bootstrap = path.join(root, "service-control.exe")
const run = (file, args) => promisify(execFile)(file, args, { cwd: root, env, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true })
const options = { home: root, env, node, npm, registerPath: async () => {} }
const reservation = createServer()
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
let password, started = false
const info = async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/info`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, 200)
  const data = await response.json()
  return { version: data.version, pid: data.pid }
}
const result = { root, port }
try {
  // Seed the historical native-upgrade boundary using npm in this fixture's
  // private prefix. Production installation correctly refuses pre-minimum targets.
  // Like production, allow exactly this package's postinstall (npm 12+ blocks it).
  await executeNpm(node, [npm, "install", "--global", "--prefix", env.npm_config_prefix,
    "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org", `--allow-scripts=${openCodeAllowScripts("2.0.15")}`,
    "@opencode/cli@2.0.15"], env, process.platform, env.npm_config_prefix)
  // Keep an independent controller so cleanup still works after failed replacement.
  await copyFile(binary, bootstrap)
  await run(bootstrap, ["service", "set", "port", String(port)])
  await run(binary, ["service", "start"])
  started = true
  password = (await run(bootstrap, ["service", "get", "password"])).stdout.trim()
  result.before = await info()
  assert.equal(result.before.version, "2.0.15")
  assert.ok(Number.isInteger(result.before.pid))
  if (process.platform === "win32") {
    await assert.rejects(async () => { await (await open(binary, "r+")).close() }, "old write-access preflight rejects this live image")
  }
  await installSharedOpenCode(RECOMMENDED_OPENCODE_VERSION, options)
  result.after = await info()
  result.installedVersion = (await run(binary, ["--version"])).stdout.trim()
  assert.equal(result.installedVersion.replace(/^opencode2? v?/, ""), RECOMMENDED_OPENCODE_VERSION)
  assert.deepEqual(result.after, result.before, "upgrade must not restart the service")
  const lifecycle = new HostOpenCodeService({ binary }, {
    execFile: (file, args) => run(file, args),
    startFile: (file, args) => run(file, args),
  })
  const activated = runtimeIdentity(await lifecycle.restart())
  result.activated = activated
  assert.equal(activated.version, RECOMMENDED_OPENCODE_VERSION, "one restart must activate the installed version")
  assert.notEqual(activated.pid, result.before.pid)
  result.success = true
} finally {
  if (started) await run(bootstrap, ["service", "stop"])
  await writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
