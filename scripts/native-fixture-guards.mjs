// Guards for isolated fixture-owned children and native acceptance pagination.
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"

const lifetimes = new WeakMap()
// Capture the spawn interval before the OS can lose the root's process row.
export function spawnFixtureChild(command, args, options) {
  const beforeSpawn = Date.now()
  const child = spawn(command, args, options)
  const lifetime = { beforeSpawn, afterSpawn: Date.now() }
  lifetimes.set(child, lifetime)
  child.once("exit", () => { lifetime.exitedBy = Date.now() })
  return child
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
  const { captureWindowsProcessTree, stopCapturedWindowsProcesses, processTreeRows } =
    await import("../packages/server/src/process-tree.ts")
  if (process.platform === "win32") {
    const lifetime = lifetimes.get(child)
    const wasAlive = child.exitCode === null && child.signalCode === null
    if (!lifetime && !wasAlive) return
    let targets = await captureWindowsProcessTree(child.pid, process.pid, observed, lifetime)
    const alive = child.exitCode === null && child.signalCode === null
    if (!lifetime && !alive) return
    if (!targets.length && alive) {
      throw new Error(`Could not attest fixture-owned Windows process ${child.pid}`)
    }
    if (alive) {
      await graceful()
      if (lifetime) {
        const captured = new Map(targets.map(row => [`${row.pid}:${row.startedAt}`, row]))
        let snapshotError
        const latest = await captureWindowsProcessTree(child.pid, process.pid, observed, lifetime)
          .catch(error => { snapshotError = error; return [] })
        for (const row of latest) {
          captured.set(`${row.pid}:${row.startedAt}`, row)
        }
        targets = [...captured.values()]
        await stopCapturedWindowsProcesses(targets)
        if (snapshotError) throw snapshotError
        return
      }
    }
    await stopCapturedWindowsProcesses(targets)
    return
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
  if (child.pid && child.spawnfile && (process.platform === "win32" || options.group || (child.exitCode === null && child.signalCode === null))) {
    try { await stopOwnedTree(child, stopped, graceMs, options) } catch (error) { treeError = error }
  }
  if (child.exitCode != null || child.signalCode != null) {
    if (await completesWithin(stopped, forceMs) && !treeError) return
  }
  child.kill()
  if (!(await completesWithin(stopped, graceMs))) child.kill("SIGKILL")
  if (await completesWithin(stopped, forceMs)) {
    if (treeError) throw treeError
    return
  }
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
