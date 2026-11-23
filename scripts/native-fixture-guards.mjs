// Guards for isolated fixture-owned children and native acceptance pagination.
import { execFile, spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const jobs = new WeakMap()
export function spawnFixtureChild(command, args, options) {
  if (process.platform !== "win32") return spawn(command, args, options)
  const root = fileURLToPath(new URL("../", import.meta.url))
  const exe = process.env.CODENOMAD_FIXTURE_JOB_EXE
    ?? path.resolve(root, process.env.CARGO_TARGET_DIR || "target", "debug", "codenomad-fixture-job.exe")
  try {
    if (!path.isAbsolute(exe)) throw new Error("Expected an absolute path")
    accessSync(exe, constants.X_OK)
  } catch (cause) {
    throw new Error("Build `cargo build -p codenomad-host-process --bin codenomad-fixture-job` or set CODENOMAD_FIXTURE_JOB_EXE", { cause })
  }
  if (options?.shell || options?.windowsVerbatimArguments || options?.stdio?.includes("ipc")) {
    throw new Error("The Windows fixture launcher accepts executable arguments and standard streams only")
  }
  const child = spawn(exe, [command, ...args], { ...options, windowsHide: true })
  if (!child.stderr) {
    jobs.set(child, Promise.resolve(undefined))
    return child
  }
  jobs.set(child, new Promise(resolve => {
    let line = ""
    const finish = pid => {
      child.stderr.off("data", accept)
      resolve(pid)
    }
    const accept = chunk => {
      line = (line + chunk).slice(-16384)
      const match = /^CODENOMAD_FIXTURE_PID=(\d+)\r?\n/m.exec(line)
      if (match) finish(Number(match[1]))
    }
    child.stderr.on("data", accept)
    child.once("close", () => finish(undefined))
    child.once("error", () => finish(undefined))
  }))
  return child
}

export async function fixtureChildPid(child) {
  return jobs.has(child) ? jobs.get(child) : child.pid
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
  const list = async () => (await promisify(execFile)("ps", ["-axo", "pid=,ppid=,lstart="], {
    env: { PATH: process.env.PATH, LC_ALL: "C" }, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
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
  let treeError
  if (jobs.has(child)) {
    if (options.close && child.exitCode === null && child.signalCode === null) {
      await completesWithin(Promise.resolve().then(options.close).catch(() => {}), graceMs)
      if (await completesWithin(stopped, graceMs)) return
    }
    // Node holds the wrapper handle; terminating it closes the kernel job.
  } else if (process.platform === "win32" && child.spawnfile) {
    throw new Error("Windows fixture children must be spawned in an owned Job Object")
  } else if (child.pid && child.spawnfile && (options.group || (child.exitCode === null && child.signalCode === null))) {
    try { await stopOwnedTree(child, stopped, graceMs, options) } catch (error) { treeError = error }
  }
  await stopFixtureHandle(child, stopped, graceMs, forceMs)
  if (treeError) throw treeError
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
