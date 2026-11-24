// POSIX fallback supervisor when the Rust fixture job binary is not built in JS-only CI jobs.
import { execFileSync, spawn } from "node:child_process"
import { closeSync, existsSync, renameSync, writeFileSync, writeSync } from "node:fs"

const parentPid = Number(process.env.CODENOMAD_FIXTURE_PARENT_PID || 0)
delete process.env.CODENOMAD_FIXTURE_PARENT_PID
const rawPidFd = Number(process.env.CODENOMAD_FIXTURE_PID_FD || 0)
const pidFd = Number.isSafeInteger(rawPidFd) && rawPidFd > 2 ? rawPidFd : null
delete process.env.CODENOMAD_FIXTURE_PID_FD
const rawGrace = Number(process.env.CODENOMAD_FIXTURE_GRACE_MS || 0)
const graceBudgetMs = Number.isFinite(rawGrace) && rawGrace >= 50 && rawGrace <= 2000 ? rawGrace : 400
const childEnv = { ...process.env, CODENOMAD_FIXTURE_GRACE_MS: String(Math.max(50, Math.floor(graceBudgetMs / 4))) }
const rawArgs = process.argv.slice(2)
let sameGroup = false
let pidFile = null
let argIndex = 0
while (argIndex < rawArgs.length) {
  if (rawArgs[argIndex] === "--same-group") {
    sameGroup = true
    argIndex++
  } else if (rawArgs[argIndex] === "--pid-file") {
    pidFile = rawArgs[argIndex + 1]
    if (!pidFile) {
      console.error("Fixture supervisor: expected path after --pid-file")
      process.exit(1)
    }
    argIndex += 2
  } else {
    break
  }
}
const [command, ...args] = rawArgs.slice(argIndex)
if (!command) {
  console.error("Fixture supervisor: expected an executable and its arguments")
  process.exit(1)
}
const psBin = ["/bin/ps", "/usr/bin/ps"].find(candidate => existsSync(candidate))

const child = spawn(command, args, { detached: !sameGroup, stdio: ["inherit", "inherit", "inherit"], env: childEnv })
let terminating = false
let childExited = false

function sameGroupPeers() {
  const peers = new Set()
  let psOk = false
  if (!childExited && child.pid) {
    try { process.kill(child.pid, 0); peers.add(child.pid) } catch (error) { if (error.code === "EPERM") peers.add(child.pid) }
  }
  if (!psBin) return { peers: [...peers], psOk: false }
  try {
    const out = execFileSync(psBin, ["-ax", "-o", "pid=,pgid=,ppid=,comm="], { encoding: "utf8", timeout: 1000 })
    psOk = true
    for (const line of out.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
      if (!match) continue
      const pid = Number(match[1]), pgid = Number(match[2]), ppid = Number(match[3]), comm = match[4]
      if (ppid === process.pid && /(?:^|\/)ps$/.test(comm)) continue
      if (pgid === process.pid && pid !== process.pid && Number.isSafeInteger(pid) && pid > 0) peers.add(pid)
    }
  } catch {}
  return { peers: [...peers], psOk }
}

function signalFamily(signal) {
  if (!child.pid) return
  if (sameGroup) {
    if (signal === "SIGTERM") {
      try { process.kill(-process.pid, "SIGTERM") } catch {}
    } else {
      for (const pid of sameGroupPeers().peers) {
        try { process.kill(pid, signal) } catch {}
      }
    }
    return
  }
  try { process.kill(-child.pid, signal) } catch {}
}

function familyAlive() {
  if (!child.pid) return false
  if (sameGroup) {
    const { peers, psOk } = sameGroupPeers()
    return !psOk || peers.length > 0
  }
  try { process.kill(-child.pid, 0); return true } catch (error) { return error.code === "EPERM" }
}

function shutdown(code, graceMs = graceBudgetMs) {
  if (terminating) return
  terminating = true
  clearInterval(watch)
  signalFamily("SIGTERM")
  const deadline = Date.now() + 5000
  const graceUntil = Math.min(Date.now() + graceMs, deadline)
  let escalated = false
  const wait = setInterval(() => {
    const alive = familyAlive()
    if (!alive) {
      clearInterval(wait)
      process.exit(code)
    }
    if (Date.now() >= deadline) {
      clearInterval(wait)
      signalFamily("SIGKILL")
      process.exit(1)
    }
    if (!escalated && Date.now() >= graceUntil) {
      escalated = true
      signalFamily("SIGKILL")
    } else if (escalated) {
      signalFamily("SIGKILL")
    }
  }, 20)
}

child.once("spawn", () => {
  const line = `CODENOMAD_FIXTURE_PID=${child.pid}\n`
  if (pidFile) {
    const tmp = `${pidFile}.tmp`
    writeFileSync(tmp, line, { mode: 0o600, flag: "wx" })
    renameSync(tmp, pidFile)
    return
  }
  if (pidFd !== null) {
    try { writeSync(pidFd, line) } finally { try { closeSync(pidFd) } catch {} }
    return
  }
  process.stderr.write(line)
})
child.once("error", error => {
  console.error(`Fixture supervisor: ${error.message}`)
  clearInterval(watch)
  process.exit(1)
})
child.once("exit", (code, signal) => {
  childExited = true
  shutdown(code ?? (signal ? 1 : 0), graceBudgetMs)
})

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    if (terminating) return
    shutdown(1, graceBudgetMs)
  })
}

const watch = setInterval(() => {
  if (!parentPid) return
  if (process.ppid !== parentPid) { shutdown(1); return }
  try { process.kill(parentPid, 0) } catch { shutdown(1) }
}, 50)
