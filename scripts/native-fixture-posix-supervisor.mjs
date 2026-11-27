// POSIX fallback supervisor when the Rust fixture job binary is not built in JS-only CI jobs.
import { execFileSync, spawn } from "node:child_process"
import { closeSync, existsSync, readSync, renameSync, writeFileSync, writeSync } from "node:fs"

const parentPid = Number(process.env.CODENOMAD_FIXTURE_PARENT_PID || 0)
delete process.env.CODENOMAD_FIXTURE_PARENT_PID
const rawPidFd = Number(process.env.CODENOMAD_FIXTURE_PID_FD || 0)
const pidFd = Number.isSafeInteger(rawPidFd) && rawPidFd > 2 ? rawPidFd : null
delete process.env.CODENOMAD_FIXTURE_PID_FD
const rawGrace = Number(process.env.CODENOMAD_FIXTURE_GRACE_MS || 0)
const graceBudgetMs = Number.isFinite(rawGrace) && rawGrace >= 50 && rawGrace <= 2000 ? rawGrace : 400
const childEnv = {
  ...process.env,
  CODENOMAD_FIXTURE_GRACE_MS: String(Math.max(50, Math.floor(graceBudgetMs / 4))),
}
const rawArgs = process.argv.slice(2)
let sameGroup = false
let gateStdin = false
let pidFile = null
let argIndex = 0
while (argIndex < rawArgs.length) {
  if (rawArgs[argIndex] === "--same-group") {
    sameGroup = true
    argIndex++
  } else if (rawArgs[argIndex] === "--gate-stdin") {
    gateStdin = true
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
if (gateStdin) {
  const token = Buffer.alloc(1)
  let bytes = 0
  try { bytes = readSync(0, token, 0, 1, null) } catch {}
  if (bytes !== 1 || token[0] !== 0x47) process.exit(1)
}
const [command, ...args] = rawArgs.slice(argIndex)
if (!command) {
  console.error("Fixture supervisor: expected an executable and its arguments")
  process.exit(1)
}
const psBin = ["/bin/ps", "/usr/bin/ps"].find(candidate => existsSync(candidate))

const child = spawn(command, args, { detached: !sameGroup, stdio: [gateStdin ? "ignore" : "inherit", "inherit", "inherit"], env: childEnv })
let terminating = false
let childExited = false
const knownDescendants = new Map()
let childStartId = null

function parsePsRows() {
  if (!psBin) return null
  try {
    const out = execFileSync(psBin, ["-ax", "-o", "pid=,pgid=,ppid=,lstart=,comm="], {
      env: { ...process.env, LC_ALL: "C" }, encoding: "utf8", timeout: 1000,
    })
    const rows = []
    let nonEmpty = 0
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue
      nonEmpty++
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(line)
      if (!match) continue
      const pid = Number(match[1]), pgid = Number(match[2]), ppid = Number(match[3]), startId = match[4].trim(), comm = match[5]
      if (ppid === process.pid && /(?:^|\/)ps$/.test(comm)) continue
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue
      rows.push({ pid, pgid, ppid, startId })
    }
    if (nonEmpty > 0 && rows.length === 0) return null
    return rows
  } catch {
    return null
  }
}

function currentStartIdOf(pid) {
  if (!psBin || !Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const out = execFileSync(psBin, ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" }, encoding: "utf8", timeout: 1000,
    }).trim()
    return out || null
  } catch {
    return null
  }
}

function familyPeers() {
  const peers = new Map()
  const rows = parsePsRows()
  const psOk = rows !== null
  if (!psOk) {
    if (!childExited && child.pid) {
      try { process.kill(child.pid, 0); peers.set(child.pid, childStartId ?? "") } catch (error) { if (error.code === "EPERM") peers.set(child.pid, childStartId ?? "") }
    }
    return { peers: [...peers.entries()], psOk: false, rootReused: false }
  }
  const byPid = new Map()
  const byParent = new Map()
  for (const row of rows) {
    byPid.set(row.pid, row)
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, [])
    byParent.get(row.ppid).push(row.pid)
  }
  if (!childExited && child.pid && !childStartId && byPid.has(child.pid)) {
    childStartId = byPid.get(child.pid).startId
  }
  const rootRow = child.pid ? byPid.get(child.pid) : null
  const rootReused = Boolean(rootRow && childStartId && rootRow.startId !== childStartId)
  const seeds = [process.pid]
  if (child.pid && !childExited && !rootReused) seeds.push(child.pid)
  for (const row of rows) {
    if (sameGroup ? row.pgid === process.pid : (!rootReused && row.pgid === child.pid)) {
      seeds.push(row.pid)
    }
  }
  for (const [knownPid, knownStart] of [...knownDescendants.entries()]) {
    const live = byPid.get(knownPid)
    if (!live || live.startId !== knownStart) {
      knownDescendants.delete(knownPid)
    } else {
      seeds.push(knownPid)
    }
  }
  const visited = new Set()
  const queue = [...seeds]
  while (queue.length > 0) {
    const current = queue.pop()
    if (visited.has(current)) continue
    visited.add(current)
    const row = byPid.get(current)
    if (row && current !== process.pid && (current !== child.pid || (!childExited && !rootReused))) {
      peers.set(current, row.startId)
      knownDescendants.set(current, row.startId)
    }
    for (const kid of byParent.get(current) ?? []) queue.push(kid)
  }
  return { peers: [...peers.entries()], psOk: true, rootReused }
}

function signalFamily(signal) {
  if (!child.pid) return
  const { peers, rootReused } = familyPeers()
  for (const [pid, expectedStart] of peers) {
    if (!expectedStart) continue
    if (currentStartIdOf(pid) !== expectedStart) continue
    try { process.kill(pid, signal) } catch {}
  }
  if (sameGroup) {
    if (signal === "SIGTERM") {
      try { process.kill(-process.pid, "SIGTERM") } catch {}
    }
    return
  }
  if (!rootReused && childStartId && currentStartIdOf(child.pid) === childStartId) {
    try { process.kill(-child.pid, signal) } catch {}
  }
}

function familyAlive() {
  if (!child.pid) return false
  const { peers, psOk, rootReused } = familyPeers()
  if (!psOk) return true
  if (peers.length > 0) return true
  if (sameGroup || rootReused) return false
  if (childStartId && currentStartIdOf(child.pid) !== childStartId) return false
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
      process.exit(86)
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
  if (parentPid && process.ppid !== parentPid) {
    shutdown(1)
    return
  }
  const line = `CODENOMAD_FIXTURE_PID=${child.pid}\n`
  try {
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
  } catch {
    shutdown(1)
  }
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
  if (!terminating) familyPeers()
  if (!parentPid) return
  if (process.ppid !== parentPid) { shutdown(1); return }
  try { process.kill(parentPid, 0) } catch { shutdown(1) }
}, 50)
