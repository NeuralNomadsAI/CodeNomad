// Run on a disposable Linux host with a systemd user manager and no linger:
//   node test-opencode-login-start-linux-native.mjs install POSIX_MODULE CLI ROOT
//   (close every session of the user, wait for the user manager to stop, log in again)
//   node test-opencode-login-start-linux-native.mjs run POSIX_MODULE CLI ROOT
//   node test-opencode-login-start-linux-native.mjs cleanup POSIX_MODULE CLI ROOT
// POSIX_MODULE is an ESM bundle of packages/server/src/host-lifetime/opencode-login-start-posix.ts
// (`esbuild --bundle --platform=node --format=esm`) copied to the host; ROOT is a run-owned directory
// for the isolated XDG roots and evidence. The unit name is unique to the run.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"

const [phase, modulePath, cli, root] = process.argv.slice(2)
assert.ok(["install", "run", "cleanup"].includes(phase) && path.isAbsolute(modulePath) && path.isAbsolute(cli) && path.isAbsolute(root))
const { LinuxLoginStart, linuxLoginUnit } = await import(pathToFileURL(modulePath).href)
const exec = promisify(execFile)
const uid = String(process.getuid())
const isolated = { XDG_CONFIG_HOME: `${root}/config`, XDG_STATE_HOME: `${root}/state`, XDG_DATA_HOME: `${root}/data`,
  XDG_CACHE_HOME: `${root}/cache`, OPENCODE_TEST_HOME: `${root}/home` }
const stateFile = path.join(root, "state.json"), unitDirectory = path.join(os.homedir(), ".config", "systemd", "user")
const run = async (file, args, env = process.env) => (await exec(file, args, { env, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim()
const service = args => run(cli, args, { ...process.env, ...isolated })
const systemctl = args => run("/usr/bin/systemctl", ["--user", ...args])
const linger = () => run("/usr/bin/loginctl", ["show-user", uid, "--property=Linger", "--value"])
const manager = () => run("/usr/bin/systemctl", ["show", `user@${uid}.service`, "--property=MainPID", "--value"])
const show = async unit => Object.fromEntries((await systemctl(["show", unit, "--property=LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainCode,ExecMainStatus,Result,UnitFileState,FragmentPath"]))
  .split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
const live = pid => Number(pid) > 0 && existsSync(`/proc/${pid}`)
const listing = async () => (await readdir(unitDirectory, { recursive: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))).sort()
const until = async (read, check, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(value)}`)
    await delay(500)
  }
}
const evidence = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) : { steps: [] }
const step = async (name, value) => { evidence.steps.push({ name, ...value }); console.log(name, JSON.stringify(value)); await writeFile(stateFile, JSON.stringify(evidence, null, 2)) }
const platform = () => new LinuxLoginStart({ unit: evidence.unit, environment: isolated })
// Mirrors resolveLoginStartLaunch on POSIX: the selected path and only the server's PATH.
const launch = { command: cli, args: ["serve", "--service"], environment: { PATH: process.env.PATH } }

async function processProof(pid, port) {
  const cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean)
  const environ = Object.fromEntries((await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").filter(Boolean).map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]))
  const listening = await run("/usr/bin/ss", ["-Hltnp", `sport = :${port}`])
  assert.deepEqual(cmdline, [cli, "serve", "--service"])
  assert.deepEqual(Object.fromEntries(Object.keys(isolated).map(key => [key, environ[key]])), isolated)
  assert.equal(environ.PATH, process.env.PATH, "the unit carries the server's PATH")
  assert.match(listening, new RegExp(`pid=${pid}\\b`))
  return { cmdline, listening }
}

let failure, ownsRoot = false
try {
if (phase === "install") {
  // Without recursive, mkdir fails on an existing directory: success proves this run owns ROOT.
  await mkdir(root)
  ownsRoot = true
  for (const directory of Object.values(isolated)) await mkdir(directory, { recursive: true })
  evidence.unit = `codenomad-opencode-login-test-${randomUUID()}.service`
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
  evidence.port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  evidence.listingBefore = await listing()
  evidence.lingerBefore = await linger()
  assert.equal(evidence.lingerBefore, "no")
  await service(["service", "set", "port", String(evidence.port)])
  assert.equal(await service(["service", "status"]), "stopped")
  await platform().install(launch)
  await platform().install(launch)
  const unit = await show(evidence.unit)
  assert.equal(await platform().installed(), true)
  assert.equal(unit.UnitFileState, "enabled")
  assert.equal(unit.ActiveState, "inactive", "enabling never starts it now")
  const unitText = await readFile(path.join(unitDirectory, evidence.unit), "utf8")
  assert.equal(unitText, linuxLoginUnit(launch, isolated))
  assert.match(unitText, /^Restart=on-abnormal\nRestartPreventExitStatus=SIGKILL$/m)
  evidence.managerBefore = await manager()
  await step("installed", { unit: evidence.unit, port: evidence.port, version: await run(cli, ["--version"]), linger: evidence.lingerBefore,
    unitFile: await readFile(path.join(unitDirectory, evidence.unit), "utf8"), state: unit, userManagerPid: evidence.managerBefore,
    sessions: await run("/usr/bin/loginctl", ["list-sessions", "--no-legend"]) })
} else if (phase === "run") {
  const { unit: name, port } = evidence
  // Login: the user manager restarted for this session and default.target pulled the unit in.
  const managerNow = await manager()
  assert.notEqual(managerNow, evidence.managerBefore, "the user manager stopped after the last logout and started at this login")
  const url = await until(() => service(["service", "status"]), value => value !== "stopped", "login start")
  assert.equal(url, `http://127.0.0.1:${port}`)
  const started = await show(name)
  assert.equal(started.ActiveState, "active")
  await step("started-at-login", { userManagerPid: { before: evidence.managerBefore, now: managerNow }, url, state: started,
    ...await processProof(started.MainPID, port), linger: await linger() })

  // Explicit stop: `opencode service stop` exits with a code, which Restart=on-abnormal never relaunches.
  const before = await show(name), pid = before.MainPID
  await service(["service", "stop"])
  await until(() => Promise.resolve(live(pid)), alive => !alive, "service stop")
  await delay(15_000)
  const stopped = await show(name), status = await service(["service", "status"])
  await step("explicit-stop", { pid, exit: { code: stopped.ExecMainCode, status: stopped.ExecMainStatus, result: stopped.Result },
    activeState: stopped.ActiveState, subState: stopped.SubState, restarts: { before: before.NRestarts, after: stopped.NRestarts },
    mainPidAfter: stopped.MainPID, serviceStatus: status })
  assert.equal(stopped.NRestarts, before.NRestarts, "opencode service stop is never followed by a restart")
  assert.equal(status, "stopped")

  // Occupied port: whatever OpenCode does (2.2.5 waits without listening), systemd never loops.
  const holder = spawn("/usr/bin/python3", ["-c", `import socket,time\ns=socket.socket()\ns.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\ns.bind(("127.0.0.1",${Number(port)}))\ns.listen()\nprint("ready",flush=True)\ntime.sleep(120)`],
    { stdio: ["ignore", "pipe", "ignore"] })
  try {
    await new Promise((resolve, reject) => { holder.stdout.once("data", resolve); holder.once("exit", reject) })
    const busyBefore = await show(name)
    await systemctl(["start", name]).catch(() => {})
    await delay(15_000)
    const busy = await show(name)
    await step("occupied-port", { exit: { code: busy.ExecMainCode, status: busy.ExecMainStatus, result: busy.Result },
      activeState: busy.ActiveState, mainPid: busy.MainPID, restarts: { before: busyBefore.NRestarts, after: busy.NRestarts },
      listener: await run("/usr/bin/ss", ["-Hltnp", `sport = :${port}`]) })
    assert.equal(busy.NRestarts, busyBefore.NRestarts, "an occupied port never loops")
  } finally { holder.kill("SIGKILL") }
  await systemctl(["stop", name]).catch(() => {})
  await systemctl(["reset-failed", name]).catch(() => {})

  // Crash signal: systemd relaunches it.
  await systemctl(["start", name])
  await until(() => service(["service", "status"]), value => value !== "stopped", "start before crash")
  const running = await show(name)
  await run("/bin/kill", ["-SEGV", running.MainPID])
  const restarted = await until(() => show(name), value => value.ActiveState === "active" && value.MainPID !== running.MainPID && value.MainPID !== "0"
    && Number(value.NRestarts) > Number(running.NRestarts), "crash restart", 30_000)
  const crashUrl = await until(() => service(["service", "status"]), value => value !== "stopped", "service after crash restart")
  await step("crash-restart", { signal: "SIGSEGV", killedPid: running.MainPID, newPid: restarted.MainPID,
    restarts: { before: running.NRestarts, after: restarted.NRestarts }, url: crashUrl, ...await processProof(restarted.MainPID, port) })

  // SIGKILL, a forced stop: not relaunched.
  await run("/bin/kill", ["-9", restarted.MainPID])
  await until(() => Promise.resolve(live(restarted.MainPID)), alive => !alive, "sigkill")
  await delay(15_000)
  const killed = await show(name), killedStatus = await service(["service", "status"])
  await step("sigkill-not-restarted", { killedPid: restarted.MainPID, exit: { code: killed.ExecMainCode, status: killed.ExecMainStatus, result: killed.Result },
    activeState: killed.ActiveState, restarts: { before: restarted.NRestarts, after: killed.NRestarts }, serviceStatus: killedStatus })
  assert.equal(killed.NRestarts, restarted.NRestarts)
  assert.equal(killedStatus, "stopped")

  // Disable: the unit goes away, OpenCode keeps running.
  await systemctl(["reset-failed", name]).catch(() => {})
  await systemctl(["start", name])
  const keptUrl = await until(() => service(["service", "status"]), value => value !== "stopped", "start before disable")
  const kept = await show(name)
  await platform().remove()
  await platform().remove()
  const removed = await show(name)
  assert.equal(await platform().installed(), false)
  assert.equal(existsSync(path.join(unitDirectory, name)), false)
  assert.equal(existsSync(path.join(unitDirectory, "default.target.wants", name)), false)
  assert.ok(live(kept.MainPID), "disabling never stops OpenCode")
  assert.equal(await service(["service", "status"]), keptUrl)
  await step("disabled-service-kept", { unitFile: "absent", wantsLink: "absent", state: removed, pid: kept.MainPID, alive: true, url: keptUrl })
}
} catch (error) { failure = error }

// Also after a failed run, or a failed install that created ROOT, so the host never keeps the unit or the service.
if (phase !== "install" || failure && ownsRoot) {
  // Run-owned cleanup: the isolated service, the transient unit state, then the checks.
  const name = evidence.unit
  const pid = name ? (await show(name).catch(() => ({ MainPID: "0" }))).MainPID : "0"
  await service(["service", "stop"]).catch(() => {})
  if (Number(pid) > 0) await until(() => Promise.resolve(live(pid)), alive => !alive, "cleanup stop").catch(() => {})
  if (name) {
    await platform().remove().catch(() => {})
    await systemctl(["stop", name]).catch(() => {})
    await systemctl(["reset-failed", name]).catch(() => {})
    await systemctl(["daemon-reload"]).catch(() => {})
  }
  const leftover = name ? await systemctl(["list-units", "--all", "--no-legend", name]) : ""
  const listingAfter = await listing()
  await step("cleanup", { unitLeft: leftover || "none", process: Number(pid) > 0 ? (live(pid) ? "live" : "dead") : "none",
    linger: await linger(), unitDirectoryUnchanged: JSON.stringify(listingAfter) === JSON.stringify(evidence.listingBefore) })
  if (failure) throw failure
  assert.equal(leftover, "")
  assert.equal(await linger(), "no")
  assert.deepEqual(listingAfter, evidence.listingBefore)
  console.log(`linux-native-login-start: ${phase} ok`)
}
if (failure) throw failure
