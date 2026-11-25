// Guards for isolated fixture-owned children and native acceptance pagination.
import { execFile, spawn } from "node:child_process"
import { accessSync, constants, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { isLocalAbsolutePath, pidAlive, probeProcessIdentity, processIdentityOf, resolveLocalExecutable } from "./native-fixture-http.mjs"

const jobs = new WeakMap()
const jobIdentities = new WeakMap()

export function fixtureJobExecutable({ required = process.platform === "win32" || process.platform === "darwin" } = {}) {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const suffix = process.platform === "win32" ? ".exe" : ""
  const rawExe = process.env.CODENOMAD_FIXTURE_JOB_EXE
    || path.resolve(root, process.env.CARGO_TARGET_DIR || "target", "debug", `codenomad-fixture-job${suffix}`)
  try {
    if (!isLocalAbsolutePath(rawExe)) throw new Error("Expected an absolute local path")
    const exe = resolveLocalExecutable(rawExe, "fixture job launcher")
    accessSync(exe, constants.X_OK)
    return exe
  } catch (cause) {
    if (!required) return null
    throw new Error("Build `cargo build -p codenomad-host-process --bin codenomad-fixture-job` or set CODENOMAD_FIXTURE_JOB_EXE", { cause })
  }
}

export function spawnFixtureChild(command, args, options) {
  if (typeof command === "string" && (path.isAbsolute(command) || /^[\\/]{2}/.test(command))) {
    command = resolveLocalExecutable(command, "fixture executable")
  }
  const exe = fixtureJobExecutable()
  if (options?.shell || options?.windowsVerbatimArguments || options?.stdio?.includes("ipc")) {
    throw new Error("The fixture launcher accepts executable arguments and standard streams only")
  }
  const env = { ...(options?.env ?? process.env), CODENOMAD_FIXTURE_PARENT_PID: String(process.pid) }
  const inheritedGrace = Number(process.env.CODENOMAD_FIXTURE_GRACE_MS || 0)
  const requestedGrace = options?.graceMs != null ? Math.floor(options.graceMs / 2) : 0
  const graceCandidates = [inheritedGrace, requestedGrace].filter(v => Number.isFinite(v) && v >= 50 && v <= 2000)
  if (graceCandidates.length && !env.CODENOMAD_FIXTURE_GRACE_MS) {
    env.CODENOMAD_FIXTURE_GRACE_MS = String(Math.min(...graceCandidates))
  }
  const { detached: _detached, graceMs: _graceMs, gate = false, stdio: rawStdio, ...restOptions } = options ?? {}
  const usePrivatePidFd = process.platform !== "win32"
  let stdio = rawStdio
  if (gate || usePrivatePidFd) {
    const baseStdio = Array.isArray(rawStdio)
      ? [gate ? "pipe" : (rawStdio[0] ?? "pipe"), rawStdio[1] ?? "pipe", rawStdio[2] ?? "pipe"]
      : typeof rawStdio === "string"
        ? [gate ? "pipe" : rawStdio, rawStdio, rawStdio]
        : ["pipe", "pipe", "pipe"]
    stdio = usePrivatePidFd ? [...baseStdio, "pipe"] : baseStdio
    if (usePrivatePidFd) env.CODENOMAD_FIXTURE_PID_FD = "3"
  }
  const supervisorFlags = gate ? ["--gate-stdin"] : []
  const supervisor = exe
    ? [exe, [...supervisorFlags, command, ...args]]
    : [process.execPath, [fileURLToPath(new URL("./native-fixture-posix-supervisor.mjs", import.meta.url)), ...supervisorFlags, command, ...args]]
  const child = spawn(supervisor[0], supervisor[1], { ...restOptions, stdio, detached: false, env, windowsHide: true })
  if (gate) {
    child.stdin?.on("error", () => {})
    let released = false
    child.releaseGate = () => {
      if (released) return
      released = true
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write("G")
        child.stdin.end()
      }
    }
    child.abortGate = () => {
      if (released) return
      released = true
      if (child.stdin && !child.stdin.destroyed) child.stdin.end()
    }
  }
  const pidStream = usePrivatePidFd ? child.stdio[3] : child.stderr
  if (!pidStream) {
    jobs.set(child, Promise.resolve(undefined))
    return child
  }
  jobs.set(child, new Promise(resolve => {
    let line = ""
    let settled = false
    const finish = pid => {
      if (settled) return
      settled = true
      pidStream.off("data", accept)
      if (usePrivatePidFd) pidStream.resume()
      resolve(pid)
    }
    const accept = chunk => {
      line += chunk
      const newline = line.indexOf("\n")
      if (newline >= 0) {
        // On Windows the job launcher writes line 1 before ResumeThread; on POSIX fd 3 is private to the supervisor.
        const firstLine = line.slice(0, newline + 1)
        const match = /^CODENOMAD_FIXTURE_PID=(\d+)\r?\n$/.exec(firstLine)
        const parsedPid = match ? Number(match[1]) : undefined
        if (usePrivatePidFd && Number.isSafeInteger(parsedPid) && parsedPid > 0) {
          jobIdentities.set(child, processIdentityOf(parsedPid).catch(() => null))
        }
        finish(parsedPid)
        return
      }
      if (line.length > 256) finish(undefined)
    }
    pidStream.on("data", accept)
    if (usePrivatePidFd) {
      pidStream.once("end", () => finish(undefined))
      pidStream.once("error", () => finish(undefined))
    }
    child.once("close", () => finish(undefined))
    child.once("error", () => finish(undefined))
  }))
  return child
}

export async function fixtureChildPid(child, timeoutMs = 10_000) {
  if (!jobs.has(child)) return child.pid
  let timer
  try {
    return await Promise.race([
      jobs.get(child),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out reading fixture child PID")), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally { clearTimeout(timer) }
}

export function clearFixtureGitEnvironment(environment = process.env) {
  for (const key of Object.keys(environment)) if (/^GIT_/i.test(key)) delete environment[key]
}

async function completesWithin(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

async function stopOwnedTree(child, stopped, graceMs, { close, group, startedBy }) {
  const observed = startedBy ?? new Date()
  const graceful = async () => {
    if (close) await completesWithin(Promise.resolve().then(close).catch(() => {}), graceMs)
    else child.kill()
    await completesWithin(stopped, graceMs)
  }
  if (group) {
    await graceful()
    try { process.kill(-child.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
    return
  }
  const psBin = ["/bin/ps", "/usr/bin/ps"].find(candidate => existsSync(candidate))
  if (!psBin) throw new Error("Expected system ps executable at /bin/ps or /usr/bin/ps")
  const list = async () => (await promisify(execFile)(psBin, ["-axo", "pid=,ppid=,lstart="], {
    env: { LC_ALL: "C" }, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  })).stdout.split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    const started = match && Date.parse(match[3])
    return Number.isFinite(started) ? [{ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: BigInt(started) }] : []
  })
  const rows = await list()
  const { processTreeRows } = await import("../packages/server/src/process-tree.ts")
  const root = rows.find(row => row.pid === child.pid && row.parentPid === process.pid)
  const targets = root && root.startedAt <= BigInt(observed.getTime()) ? processTreeRows(child.pid, rows) : []
  if (!targets.length && child.exitCode === null && child.signalCode === null) {
    throw new Error(`Could not attest fixture-owned process ${child.pid}`)
  }
  if (!startedBy && (child.exitCode !== null || child.signalCode !== null)) return
  await graceful()
  const current = new Map((await list()).map(row => [row.pid, row.startedAt]))
  for (const row of targets.reverse()) {
    if (current.get(row.pid) !== row.startedAt) continue
    try { process.kill(row.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
  }
}

export async function stopFixtureChild(child, stopped, graceMs = 1_000, forceMs = 2_000, options = {}) {
  child.abortGate?.()
  let treeError
  const isJob = jobs.has(child)
  if (isJob) {
    if (options.close && child.exitCode === null && child.signalCode === null) {
      await completesWithin(Promise.resolve().then(options.close).catch(() => {}), graceMs)
      if (await completesWithin(stopped, graceMs)) {
        if (child.exitCode === 86) {
          throw new Error(`Fixture supervisor ${child.pid} reported incomplete child tree termination`)
        }
        return
      }
    }
    // Node holds the wrapper handle; on Windows terminating it closes the kernel job,
    // while on POSIX the supervisor needs its full 5 s family verification window before outer SIGKILL.
  } else if (process.platform === "win32" && child.spawnfile) {
    throw new Error("Windows fixture children must be spawned in an owned Job Object")
  } else if (child.pid && child.spawnfile && (options.group || (child.exitCode === null && child.signalCode === null))) {
    try { await stopOwnedTree(child, stopped, graceMs, options) } catch (error) { treeError = error }
  }
  const handleGrace = isJob && process.platform !== "win32" ? Math.max(graceMs, 5_500) : graceMs
  let handleError
  try {
    await stopFixtureHandle(child, stopped, handleGrace, forceMs)
  } catch (error) {
    handleError = error
  }
  if (isJob && process.platform !== "win32" && (child.signalCode === "SIGKILL" || handleError)) {
    const innerPid = await fixtureChildPid(child, 200).catch(() => undefined)
    if (Number.isSafeInteger(innerPid) && innerPid > 0) {
      const expected = await Promise.resolve(jobIdentities.get(child)).catch(() => null)
      const current = expected?.startId ? await processIdentityOf(innerPid, { refresh: true }).catch(() => null) : null
      if (expected?.startId && current?.startId === expected.startId) {
        try { process.kill(-innerPid, "SIGKILL") } catch {}
        try { process.kill(innerPid, "SIGKILL") } catch {}
        throw new Error(`Fixture supervisor was force-killed while child group ${innerPid} remained alive`)
      }
      throw new Error(`Fixture supervisor ${child.pid} was force-killed without verified full child-tree termination for PID ${innerPid}`)
    }
    throw new Error(`Fixture supervisor ${child.pid} was force-killed before certifying child-tree termination`)
  }
  if (isJob && child.exitCode === 86) {
    throw new Error(`Fixture supervisor ${child.pid} reported incomplete child tree termination`)
  }
  if (handleError) throw handleError
  if (treeError) throw treeError
}

export async function hardKillFixtureChild(child, stopped, timeoutMs = 5_000) {
  child.abortGate?.()
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`Owned fixture child ${child.pid} already exited before hard kill`)
  }
  const isJob = jobs.has(child)
  const innerPid = isJob ? await fixtureChildPid(child, 200).catch(() => undefined) : child.pid
  const expected = isJob ? await Promise.resolve(jobIdentities.get(child)).catch(() => null) : null
  const confirmGone = async () => {
    if (!Number.isSafeInteger(innerPid) || innerPid <= 0) return
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!pidAlive(innerPid)) return
      if (expected?.startId) {
        const res = await probeProcessIdentity(innerPid, { refresh: true }).catch(() => ({ status: "unknown", identity: null }))
        if (res.status === "dead") return
        if (res.status === "ok" && res.identity?.startId !== expected.startId) return
        // Never treat 'unknown' as gone; keep waiting until confirmed dead/recycled or deadline.
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Owned fixture child PID ${innerPid} remained alive or unconfirmed after hard kill`)
  }
  if (process.platform === "win32") {
    // Terminating the Windows job wrapper closes the kernel Job Object and kills its exact child without PID addressing.
    child.kill("SIGKILL")
    if (!(await completesWithin(stopped, timeoutMs))) {
      throw new Error(`Owned fixture job ${child.pid} did not exit after hard kill`)
    }
    if (child.exitCode === 86) {
      throw new Error(`Owned fixture job ${child.pid} reported incomplete tree termination after hard kill`)
    }
    await confirmGone()
    return
  }
  if (isJob) {
    const current = Number.isSafeInteger(innerPid) && innerPid > 0 && expected?.startId
      ? await processIdentityOf(innerPid, { refresh: true }).catch(() => null)
      : null
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Owned fixture child ${child.pid} exited while verifying identity for hard kill`)
    }
    if (!expected?.startId || current?.startId !== expected.startId) {
      throw new Error(`Refused to hard-kill unverified or recycled fixture PID ${innerPid}`)
    }
    const signalErrors = []
    for (const target of [-innerPid, innerPid]) {
      try {
        process.kill(target, "SIGKILL")
      } catch (error) {
        if (error?.code !== "ESRCH") signalErrors.push(error)
      }
    }
    if (signalErrors.length) {
      throw new Error(`Failed to hard-kill fixture PID ${innerPid}: ${signalErrors[0].message}`)
    }
    if (!(await completesWithin(stopped, timeoutMs))) {
      throw new Error(`Owned fixture job ${child.pid} did not exit after verified hard kill`)
    }
    if (child.exitCode === 86) {
      throw new Error(`Owned fixture job ${child.pid} reported incomplete tree termination after hard kill`)
    }
    await confirmGone()
    return
  }
  child.kill("SIGKILL")
  if (!(await completesWithin(stopped, timeoutMs))) {
    throw new Error(`Owned fixture child ${child.pid} did not exit after hard kill`)
  }
  await confirmGone()
}

// Stop a leaf IPC worker or one member of an already owned enclosing job.
export async function stopFixtureHandle(child, stopped, graceMs = 1_000, forceMs = 2_000) {
  if (child.exitCode != null || child.signalCode != null) {
    if (await completesWithin(stopped, forceMs)) return
  }
  child.kill()
  if (!(await completesWithin(stopped, graceMs))) child.kill("SIGKILL")
  if (await completesWithin(stopped, forceMs)) return
  // A failed OS kill must report failure rather than retaining test handles.
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.stdin?.destroy()
  child.stdio?.[3]?.destroy?.()
  child.unref()
  throw new Error(`Fixture-owned child ${child.pid} did not exit after forced termination`)
}

export function fixturePaginationGuard() {
  const seen = new Set()
  return cursor => {
    if (seen.has(cursor)) throw new Error("Native fixture pagination repeated a nonterminal cursor")
    seen.add(cursor)
  }
}
