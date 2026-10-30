// node --import tsx scripts/test-service-supervision-health-native.mjs ABSOLUTE_CLI
// Exact-file health qualification only; OS supervision has separate platform gates.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, stat, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:net"
import { setTimeout } from "node:timers/promises"
import { readSupervisionHealth } from "../packages/server/src/host-lifetime/service-supervision-health.ts"
import { lookupProcess } from "../packages/server/src/host-lifetime/process-identity.ts"

const binary = process.argv[2]
assert.ok(binary && path.isAbsolute(binary), "an explicit absolute isolated-test CLI is required")
const shared = path.join(os.homedir(), ".local/state/opencode/service.json")
const fingerprint = async () => {
  try {
    const bytes = await readFile(shared), metadata = await stat(shared)
    return { sha256: createHash("sha256").update(bytes).digest("hex"), mtime: metadata.mtime.toISOString() }
  } catch (error) { if (error.code === "ENOENT") return null; throw error }
}
const before = await fingerprint()
const temp = path.join(os.tmpdir(), "opencode")
await mkdir(temp, { recursive: true })
const root = await mkdtemp(path.join(temp, "supervision-health-native-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|COMSPEC|PATH)$/i.test(key)))
for (const [key, name] of Object.entries({ HOME: "home", USERPROFILE: "home", OPENCODE_TEST_HOME: "home",
  APPDATA: "appdata", LOCALAPPDATA: "localappdata", XDG_CONFIG_HOME: "config", XDG_STATE_HOME: "state",
  XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_RUNTIME_DIR: "runtime", OPENCODE_CONFIG_DIR: "opencode", TEMP: "tmp", TMP: "tmp" })) {
  env[key] = path.join(root, name)
  await mkdir(env[key], { recursive: true })
}
Object.assign(env, { OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_CONFIG_CONTENT: "{}" })
const run = args => promisify(execFile)(binary, args, { cwd: root, env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
const reservation = createServer()
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
assert.notEqual(port, 28894)
const registration = path.join(env.XDG_STATE_HOME, "opencode", "service.json")
const result = { platform: process.platform, port, sharedBefore: before }
let attemptedStart = false
try {
  await run(["service", "set", "port", String(port)])
  attemptedStart = true
  await run(["service", "start"])
  const first = await readSupervisionHealth(registration)
  assert.equal(first.state, "healthy")
  const second = await readSupervisionHealth(registration)
  assert.deepEqual(second, first, "read-only observation must preserve incarnation and start identity")
  result.health = first
  result.passed = true
} finally {
  // Cleanup always targets the fresh sandbox namespace, including a lost start ACK.
  if (attemptedStart) await run(["service", "stop"])
  assert.equal((await readSupervisionHealth(registration)).state, "absent", "isolated service must be gone before deleting its roots")
  if (result.health?.state === "healthy") {
    let exited = false
    for (let attempt = 0; attempt < 30; attempt++) {
      const observed = await lookupProcess(result.health.pid)
      if (observed.state === "dead" || observed.state === "live" && observed.startIdentity !== result.health.startIdentity) { exited = true; break }
      await setTimeout(100)
    }
    assert.ok(exited, "wait for the isolated process exit, not just registration removal")
  }
  result.sharedAfter = await fingerprint()
  assert.deepEqual(result.sharedAfter, before)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  result.cleaned = true
  console.log(JSON.stringify(result, null, 2))
}
