import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

/** The endpoint handshake a daemon announces on stdout: no discovery
 * directory, no claim protocol, no foreign ready files — the url and the
 * secret travel from the spawner to the borrowers, never through the
 * filesystem. */
export interface DaemonEndpoint {
  readonly url: string
  readonly secret: string
  readonly pid: number
}

export interface SpawnedDaemon extends DaemonEndpoint {
  readonly child: ChildProcess
  readonly logDirectory: string
}

const daemonScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.mjs")

/** The handshake record, or null for any other stdout line. */
function parseEndpoint(line: string): DaemonEndpoint | null {
  try {
    const record = JSON.parse(line)
    return record?.kind === "fixture-daemon-endpoint" && typeof record.url === "string" && typeof record.secret === "string"
      && Number.isInteger(record.pid) ? { url: record.url, secret: record.secret, pid: record.pid } : null
  } catch {
    return null
  }
}

export interface SpawnDaemonOptions {
  uiRoot: string
  /** Run the startup warmup page load; defaults to true for real runs. */
  warmup?: boolean
  /** Prefix for the daemon.log directory (run- vs standalone-named). */
  logPrefix?: string
  timeoutMs?: number
  /** Test seam: the entry script to spawn instead of daemon.mjs. */
  script?: string
}

/** Spawns a fixture daemon child and resolves its announced endpoint. The
 * child watches its parent (CODENOMAD_FIXTURE_PARENT_PID), so a runner
 * killed without cleanup — even SIGKILLed — never leaks its daemon. */
export async function spawnDaemon(options: SpawnDaemonOptions): Promise<SpawnedDaemon> {
  const { uiRoot, warmup = true, logPrefix = "codenomad-fixture-run-", timeoutMs = 90_000, script = daemonScript } = options
  const logDirectory = await mkdtemp(path.join(tmpdir(), logPrefix))
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: uiRoot,
    // stdin is unused, stderr stays visible; only the handshake stdout is a
    // pipe, and spawnDaemon releases it the moment the endpoint arrives so
    // the spawner's event loop can drain while the daemon child lives on.
    stdio: ["ignore", "pipe", "inherit"],
    // Windows ends an attached child with its owner, before the daemon's parent
    // watch can run its cleanup; detached, it outlives the owner long enough to.
    detached: process.platform === "win32",
    windowsHide: true,
    env: {
      ...process.env,
      CODENOMAD_FIXTURE_LOG_DIR: logDirectory,
      CODENOMAD_FIXTURE_PARENT_PID: String(process.pid),
      ...(warmup ? {} : { CODENOMAD_FIXTURE_WARMUP: "0" }),
    },
  })
  const log = path.join(logDirectory, "daemon.log")
  const lines = createInterface({ input: child.stdout! })
  let timer: ReturnType<typeof setTimeout> | undefined
  let onError: (error: Error) => void = () => {}
  let onClose: (code: number | null) => void = () => {}
  try {
    const endpoint = await new Promise<DaemonEndpoint>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture daemon did not announce its endpoint within ${timeoutMs}ms (log: ${log})`)), timeoutMs)
      // Whole lines only: a record split across chunks, or other output that
      // mentions the marker, is never parsed as the handshake.
      lines.on("line", line => {
        const record = parseEndpoint(line)
        if (record) resolve(record)
      })
      onError = reject
      onClose = code => reject(new Error(`fixture daemon exited before announcing its endpoint (code ${code}; log: ${log})`))
      child.once("error", onError)
      child.once("close", onClose)
    })
    return { ...endpoint, child, logDirectory }
  } catch (error) {
    // A daemon that never announced cannot be asked to stop: end it here so a
    // failed start leaves nothing behind for the caller's fallback.
    child.kill()
    throw error
  } finally {
    // The handshake is the only thing the pipe is for: holding it, the timer or
    // the child handle would keep the spawner's event loop from draining. The
    // daemon swallows the EPIPE on any later write, and its parent watch, not
    // the spawner's loop, reaps it.
    clearTimeout(timer)
    child.off("error", onError)
    child.off("close", onClose)
    lines.close()
    child.stdout?.destroy()
    child.unref()
  }
}

export interface RunDaemon {
  readonly url: string
  readonly secret: string
  readonly pid: number
  /** Where the daemon's daemon.log lives, for post-mortem and CI artifacts. */
  readonly logDirectory: string
  /** Environment variables a borrower process needs to attach to this daemon. */
  readonly env: Record<string, string>
  /** Portable teardown: the daemon is asked over HTTP (a Windows kill never
   * runs signal handlers), runs its own cleanup, and exits; a force-kill
   * follows only if it never exits. Rejects when the cleanup failed (nonzero
   * exit) or had to be forced; repeated calls share one teardown. */
  stop(): Promise<void>
}

/** A runner's daemon: spawned here, handed to test processes through the
 * environment, and stopped when the runner's slice ends. */
export async function startRunDaemon(options: SpawnDaemonOptions): Promise<RunDaemon> {
  const daemon = await spawnDaemon(options)
  const exited = new Promise<number | null>(resolve => {
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) return resolve(daemon.child.exitCode)
    daemon.child.on("close", code => resolve(code))
    daemon.child.on("error", () => resolve(null))
  })
  let stopping: Promise<void> | null = null
  return {
    url: daemon.url,
    secret: daemon.secret,
    pid: daemon.pid,
    logDirectory: daemon.logDirectory,
    env: {
      CODENOMAD_FIXTURE_URL: daemon.url,
      CODENOMAD_FIXTURE_SECRET: daemon.secret,
    },
    stop() {
      stopping ??= (async () => {
        // The handle was unref'd after the handshake: hold it until the exit is
        // observed, or after a forced kill nothing keeps the runner alive to see it.
        daemon.child.ref()
        try {
          try {
            await fetch(`${daemon.url}/__daemon/shutdown`, {
              method: "POST",
              headers: { "x-fixture-secret": daemon.secret },
              signal: AbortSignal.timeout(15_000),
            })
          } catch { /* already gone, or wedged: the force-kill below decides */ }
          let forced = false
          const grace = setTimeout(() => {
            forced = true
            try { daemon.child.kill("SIGKILL") } catch { /* already gone */ }
          }, 15_000)
          const code = await exited
          clearTimeout(grace)
          if (forced || code !== 0) {
            throw new Error(`fixture daemon teardown failed (${forced ? "killed after 15 s" : `exit code ${code}`}; log: ${path.join(daemon.logDirectory, "daemon.log")})`)
          }
        } finally {
          daemon.child.unref()
        }
      })()
      return stopping
    },
  }
}
