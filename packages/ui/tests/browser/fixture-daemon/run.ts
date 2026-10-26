import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
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

export interface SpawnDaemonOptions {
  uiRoot: string
  /** Run the startup warmup page load; defaults to true for real runs. */
  warmup?: boolean
  /** Prefix for the daemon.log directory (run- vs standalone-named). */
  logPrefix?: string
  timeoutMs?: number
}

/** Spawns a fixture daemon child and resolves its announced endpoint. The
 * child watches its parent (CODENOMAD_FIXTURE_PARENT_PID), so a runner
 * killed without cleanup — even SIGKILLed — never leaks its daemon. */
export async function spawnDaemon(options: SpawnDaemonOptions): Promise<SpawnedDaemon> {
  const { uiRoot, warmup = true, logPrefix = "codenomad-fixture-run-", timeoutMs = 90_000 } = options
  const logDirectory = await mkdtemp(path.join(tmpdir(), logPrefix))
  const child = spawn(process.execPath, ["--import", "tsx", daemonScript], {
    cwd: uiRoot,
    // stdin is unused, stderr stays visible; only the handshake stdout is a
    // pipe, and spawnDaemon releases it the moment the endpoint arrives so
    // the spawner's event loop can drain while the daemon child lives on.
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      CODENOMAD_FIXTURE_LOG_DIR: logDirectory,
      CODENOMAD_FIXTURE_PARENT_PID: String(process.pid),
      ...(warmup ? {} : { CODENOMAD_FIXTURE_WARMUP: "0" }),
    },
  })
  const endpoint = await new Promise<DaemonEndpoint>((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(() => reject(new Error(`fixture daemon did not announce its endpoint within ${timeoutMs}ms (log: ${path.join(logDirectory, "daemon.log")})`)), timeoutMs)
    const settle = (outcome: () => void) => { clearTimeout(timer); outcome() }
    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk
      const line = buffer.split("\n").find(candidate => candidate.includes("\"fixture-daemon-endpoint\""))
      if (line) settle(() => {
        try { resolve(JSON.parse(line)) } catch (error) { reject(error) }
      })
    })
    child.on("error", error => settle(() => reject(error)))
    child.on("close", code => settle(() => reject(new Error(`fixture daemon exited before announcing its endpoint (code ${code}; log: ${path.join(logDirectory, "daemon.log")})`))))
  })
  // The handshake is the only thing the pipe is for: hold on to it and the
  // spawner's event loop can never drain (its own tests done, the daemon's
  // stdout pipe still open). Release it; the daemon swallows the EPIPE on
  // any later write. The child handle itself is unref'd for the same
  // reason — the daemon is meant to outlive its spawner's loop, and the
  // parent watch (not the spawner's goodwill) reaps it.
  child.stdout?.destroy()
  child.unref()
  return { ...endpoint, child, logDirectory }
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
   * follows only if it never answers. */
  stop(): Promise<void>
}

/** A runner's daemon: spawned here, handed to test processes through the
 * environment, and stopped when the runner's slice ends. */
export async function startRunDaemon(options: SpawnDaemonOptions): Promise<RunDaemon> {
  const daemon = await spawnDaemon(options)
  const exited = new Promise<void>(resolve => {
    daemon.child.on("close", () => resolve())
    daemon.child.on("error", () => resolve())
  })
  return {
    url: daemon.url,
    secret: daemon.secret,
    pid: daemon.pid,
    logDirectory: daemon.logDirectory,
    env: {
      CODENOMAD_FIXTURE_URL: daemon.url,
      CODENOMAD_FIXTURE_SECRET: daemon.secret,
    },
    async stop() {
      try {
        await fetch(`${daemon.url}/__daemon/shutdown`, {
          method: "POST",
          headers: { "x-fixture-secret": daemon.secret },
          signal: AbortSignal.timeout(15_000),
        })
      } catch { /* already gone, or wedged: the force-kill below decides */ }
      const grace = setTimeout(() => { try { daemon.child.kill("SIGKILL") } catch { /* already gone */ } }, 15_000)
      await exited
      clearTimeout(grace)
    },
  }
}
