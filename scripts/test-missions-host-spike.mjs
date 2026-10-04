// Private host-lifecycle fixture. It never launches either desktop, a user daemon, or a product server.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { attachPersistentHost } from "./missions-host-spike/host-client.mjs"
import { delay, pidAlive, requestJson, writeJsonAtomic } from "./missions-host-spike/protocol.mjs"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const approvedTemp = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode")
  : path.join("C:/Users/Admin/AppData/Local/Temp/opencode")
const root = path.join(approvedTemp, `missions-host-spike-${process.pid}-${Date.now()}`)
const profile = "private-host-spike"
const profileDirectory = path.join(root, "profile")
const sharedDaemonMarker = path.join(root, "shared-opencode-daemon.marker")
const launcher = path.join(repository, "scripts/missions-host-spike/launch-client.mjs")
const evidence = { root, assertions: [] }
await mkdir(profileDirectory, { recursive: true })
await writeFile(sharedDaemonMarker, "shared-daemon-owned-externally\n")

function client() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, profileDirectory, profile, sharedDaemonMarker], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let stdout = "", stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    child.once("error", reject)
    child.once("close", code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr.trim() || `client exit ${code}`)))
  })
}

async function until(predicate, label, timeout = 6_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error(`Timeout: ${label}`)
}

let authority
try {
  const electronSource = await readFile(path.join(repository, "packages/electron-app/electron/main/multiwindow-lifecycle.ts"), "utf8")
  const tauriShutdown = await readFile(path.join(repository, "packages/tauri-app/src-tauri/src/shutdown.rs"), "utf8")
  const tauriManager = await readFile(path.join(repository, "packages/tauri-app/src-tauri/src/cli_manager.rs"), "utf8")
  const serverSource = await readFile(path.join(repository, "packages/server/src/index.ts"), "utf8")
  assert.match(electronSource, /cliManager\.shutdown\(\)/)
  assert.match(tauriShutdown, /state\.manager\.stop\(\)/)
  assert.match(tauriManager, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/)
  assert.match(serverSource, /installShutdownStdinHandler\(process\.stdin/)
  evidence.assertions.push("current Electron/Tauri quit paths stop their child backend; Tauri Windows job closes its tree; server control is tied to stdin")

  const raced = await Promise.all(Array.from({ length: 8 }, () => client()))
  assert.equal(new Set(raced.map(result => result.managerPid)).size, 1)
  assert.equal(new Set(raced.map(result => result.pid)).size, 1)
  authority = raced[0]
  assert(pidAlive(authority.managerPid) && pidAlive(authority.pid), "Detached manager and backend survive all launcher clients")
  evidence.race = { clients: raced.length, managerPid: authority.managerPid, backendPid: authority.pid, generation: authority.generation }

  const reattached = await client()
  assert.equal(reattached.managerPid, authority.managerPid)
  assert.equal(reattached.pid, authority.pid)
  assert.equal(reattached.generation, authority.generation)
  assert.equal(reattached.automationAvailable, false)
  assert.equal(reattached.nativeParent, "persistent-manager")
  assert.equal(reattached.token, authority.token)
  evidence.assertions.push("last launcher exit detaches without shutdown; the same profile reattaches to the same manager/backend PID and auth origin")

  await assert.rejects(requestJson(`${authority.controlUrl}/status`, "wrong-token", profile), error => error.status === 401)
  await assert.rejects(requestJson(`${authority.controlUrl}/status`, authority.token, "other-profile"), error => error.status === 403)
  const automation = await requestJson(`${authority.controlUrl}/automation`, authority.token, profile)
  assert.deepEqual(automation, { available: false, reason: "no-attached-native-window" })
  evidence.assertions.push("token and profile-origin fences reject foreign attachment; headless automation is disabled")

  const admissions = await Promise.all(Array.from({ length: 6 }, () => requestJson(`${authority.controlUrl}/admit`, authority.token, profile, { method: "POST", body: "{}" })))
  assert.deepEqual(admissions.map(item => item.admitted).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
  const fenced = await requestJson(`${authority.controlUrl}/status`, authority.token, profile)
  assert.equal(fenced.maximumActive, 1)
  assert(admissions.every(item => item.managerPid === authority.managerPid && item.backendPid === authority.pid))
  evidence.assertions.push("all concurrent admissions traverse one manager-owned fence (maximum active = 1)")

  const liveConflict = path.join(root, "live-conflict")
  await mkdir(liveConflict, { recursive: true })
  await writeFile(path.join(liveConflict, "host.auth"), `${authority.token}\n`)
  await writeJsonAtomic(path.join(liveConflict, "host.json"), { profile: "conflict", managerPid: process.pid, controlUrl: "http://127.0.0.1:1", generation: "live" })
  await assert.rejects(attachPersistentHost({ profileDirectory: liveConflict, profile: "conflict", sharedDaemonMarker }), /refusing split brain/)
  evidence.assertions.push("an unreachable registration whose owner PID is alive fails closed instead of spawning a second manager")

  process.kill(authority.managerPid)
  await until(() => !pidAlive(authority.managerPid), "crashed manager exit")
  await until(() => !pidAlive(authority.pid), "backend exits after persistent manager IPC breaks")
  const recovered = await client()
  assert.notEqual(recovered.managerPid, authority.managerPid)
  assert.notEqual(recovered.generation, authority.generation)
  authority = recovered
  evidence.recovery = { managerPid: recovered.managerPid, backendPid: recovered.pid, generation: recovered.generation }
  evidence.assertions.push("a dead-owner registration is quarantined and recovered with a new generation; the orphan backend exits on manager-channel break")

  const stopped = await requestJson(`${authority.controlUrl}/stop`, authority.token, profile, { method: "POST", body: "{}" })
  assert.deepEqual(stopped, { authorityStopped: true, sharedDaemonStopped: false, sharedDaemonUntouched: true })
  await until(() => !pidAlive(authority.managerPid), "explicit authority stop")
  assert.equal(await readFile(sharedDaemonMarker, "utf8"), "shared-daemon-owned-externally\n")
  evidence.assertions.push("explicit authority stop terminates only the private backend/manager and leaves the shared-daemon sentinel untouched")
  evidence.status = "passed"
  await writeFile(path.join(root, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`PASS missions persistent-host spike: ${root}`)
} catch (error) {
  evidence.status = "failed"
  evidence.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
  await writeFile(path.join(root, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`)
  throw error
} finally {
  if (authority?.managerPid && pidAlive(authority.managerPid)) process.kill(authority.managerPid)
}
