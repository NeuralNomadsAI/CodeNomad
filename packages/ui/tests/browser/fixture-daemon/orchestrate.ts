import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { newestSourceMtime } from "./freshness.ts"

/** One invocation's handle on the shared fixture daemon. The runner that
 * started it owns it and stops it when its slice ends; a runner that found
 * a healthy, fresh daemon adopts it and leaves stopping to its owner. */
export interface InvocationDaemon {
  readonly pid: number
  readonly readyDirectory: string
  readonly owned: boolean
  stop(): Promise<void>
}

interface ReadyFile { port: number, pid: number, secret: string, startedAt: number }

export interface InvocationDaemonOptions {
  uiRoot: string
  readyDirectory: string
  /** Run the startup warmup page load; defaults to true for real runs. */
  warmup?: boolean
  /** Override the staleness trees (tests); defaults to the served trees. */
  freshnessRoots?: string[]
  timeoutMs?: number
}

const daemonScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.mjs")
const pollIntervalMs = 250

function defaultFreshnessRoots(uiRoot: string): string[] {
  return [
    path.join(uiRoot, "src"),
    path.join(uiRoot, "tests/browser/fixtures"),
    path.resolve(uiRoot, "../server/src"),
  ]
}

async function readReady(readyFile: string): Promise<ReadyFile | null> {
  return readFile(readyFile, "utf8").then(JSON.parse, () => null)
}

async function healthy(ready: ReadyFile): Promise<boolean> {
  return fetch(`http://127.0.0.1:${ready.port}/__daemon/health`, { signal: AbortSignal.timeout(5_000) })
    .then(response => (response.ok ? response.json() : null))
    .then((body: { pid?: number, ready?: boolean } | null) => body?.ready === true && body.pid === ready.pid)
    .catch(() => false)
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return true }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  return false
}

async function stopDaemon(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM") } catch { /* already gone */ }
  // The daemon removes its own ready file on the way down; give it a
  // bounded window so the next start never claims a live directory.
  await waitForExit(pid, 15_000)
}

/** The runner's daemon lifecycle: adopt a healthy daemon whose source tree
 * has not moved past it, retire a stale one, or start a fresh daemon — then
 * hand back who owns stopping it. */
export async function ensureInvocationDaemon(options: InvocationDaemonOptions): Promise<InvocationDaemon> {
  const { uiRoot, readyDirectory, warmup = true, timeoutMs = 90_000 } = options
  const freshnessRoots = options.freshnessRoots ?? defaultFreshnessRoots(uiRoot)
  const readyFile = path.join(readyDirectory, "ready")

  const serving = await readReady(readyFile)
  if (serving && await healthy(serving)) {
    const newest = await newestSourceMtime(freshnessRoots)
    // Same-millisecond floor as the daemon's register guard (mtimeMs is
    // fractional, startedAt is whole milliseconds).
    if (Math.floor(newest) <= serving.startedAt) {
      return { pid: serving.pid, readyDirectory, owned: false, stop: async () => {} }
    }
    console.log(`fixture daemon pid ${serving.pid} is stale (sources newer than ${new Date(serving.startedAt).toISOString()}); replacing`)
    await stopDaemon(serving.pid)
  }

  // stderr is inherited: a starter that dies before claiming (uid refusal,
  // live-owner refusal, crash) stays visible in the runner's output instead
  // of vanishing into a 90 s poll against nothing.
  const starter = spawn(process.execPath, ["--import", "tsx", daemonScript], {
    detached: true, stdio: ["ignore", "ignore", "inherit"], cwd: uiRoot,
    env: {
      ...process.env,
      CODENOMAD_FIXTURE_READY_DIR: readyDirectory,
      ...(warmup ? {} : { CODENOMAD_FIXTURE_WARMUP: "0" }),
    },
  })
  starter.unref()
  // The starter that won the claim BECOMES the daemon and writes its own pid
  // into the ready file; one that lost yields with exit 0 and someone else's
  // pid appears there. Owning the stop right is exactly pid equality — a
  // runner whose starter yielded adopts the winner and must never stop
  // another runner's daemon out from under its slice.
  const starterPid = starter.pid

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await readReady(readyFile)
    if (ready && await healthy(ready)) {
      const owned = ready.pid === starterPid
      if (!owned) { try { starter.kill("SIGTERM") } catch { /* already yielded */ } }
      return {
        pid: ready.pid, readyDirectory, owned,
        stop: owned ? () => stopDaemon(ready.pid) : (async () => {}),
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`fixture daemon did not become ready at ${readyFile}`)
}
