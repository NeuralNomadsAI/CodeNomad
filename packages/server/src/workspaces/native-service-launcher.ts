import { spawn } from "node:child_process"
import type { Readable } from "node:stream"

export interface NativeServiceStartRequest {
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
  windowsVerbatimArguments: boolean
}

export interface NativeServiceSpawnOptions {
  cwd: string
  env: Record<string, string>
  windowsVerbatimArguments: boolean
  windowsHide: true
  shell: false
  detached: boolean
  stdio: ["ignore", "pipe", "pipe"]
}

/** Owned by the native manager, not by a request or a renderer. Before returning
 * the child, a persistent Windows implementation must natively verify that the
 * starter is outside the backend Job (and will not inherit a UI-owned kill Job).
 * A flag, ordinary backend spawn, or synthetic CLI output is not that proof.
 * It must preserve the supplied executable, arguments, environment and options.
 * Async producers MUST call prepareServiceStarter at creation, before returning
 * or awaiting a Promise. An arbitrary Promise<ChildProcess> is not safe: Node
 * can emit error on nextTick before the launcher receives that child. */
export type SpawnOutsideBackendContainment = (
  file: string, args: string[], options: NativeServiceSpawnOptions, deadline: number,
) => OwnedServiceStarter | Promise<PreparedServiceStarter>

/** A real owned starter, not necessarily a Node ChildProcess. Native adapters
 * expose actual pipe Readables and exact-handle termination/close observations. */
export interface OwnedServiceStarter {
  stdout: Readable
  stderr: Readable
  exitCode: number | null
  signalCode: string | null
  kill(signal: "SIGKILL"): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
  once(event: "close", listener: (code: number | null) => void): unknown
}

const preparedStarter = Symbol("prepared-service-starter")
/** A one-use observation handoff, NOT native placement/ownership attestation. */
export interface PreparedServiceStarter { readonly [preparedStarter]: true }
interface StarterHandoff {
  starter: OwnedServiceStarter
  output: { stdout: Buffer[]; stderr: Buffer[] }
  failed: boolean
  closed: boolean
  code: number | null
  changed?: () => void
  cleanup(success: boolean): void
}
const handoffs = new WeakMap<PreparedServiceStarter, StarterHandoff>()

/** Call synchronously as soon as an async producer creates its actual starter,
 * before any await/Promise return. Retain errors (without their private detail)
 * and close until the launcher takes ownership. Synchronously capture/count each
 * stream through handoff: Node may automatically drain child stdio on exit, so
 * merely leaving the raw Readable paused does not preserve its bytes. Independent
 * 64 KiB limits apply before and after handoff, with one ordered capture per stream.
 * The producer owns the starter until handoff and must clean it up if it abandons
 * preparation instead of returning the token. This is not native attestation. */
export function prepareServiceStarter(starter: OwnedServiceStarter): PreparedServiceStarter {
  let cleaned = false
  const size = { stdout: 0, stderr: 0 }
  const state: StarterHandoff = {
    starter, output: { stdout: [], stderr: [] }, failed: false, closed: false, code: null,
    cleanup(success) {
      if (cleaned) return
      cleaned = true
      // Only this exact starter handle is ours, never a daemon or process tree.
      if (!success && starter.exitCode === null && starter.signalCode === null) {
        try { starter.kill("SIGKILL") } catch { /* Native/spawn details stay private. */ }
      }
      starter.stdout.destroy()
      starter.stderr.destroy()
      state.output.stdout.length = 0
      state.output.stderr.length = 0
    },
  }
  const failed = () => { state.failed = true; state.cleanup(false); state.changed?.() }
  starter.on("error", failed)
  starter.once("close", code => { state.closed = true; state.code = code; state.changed?.() })
  for (const stream of ["stdout", "stderr"] as const) {
    starter[stream].on("error", failed)
    starter[stream].once("end", () => state.changed?.())
    starter[stream].on("data", (chunk: Buffer | string) => {
      if (cleaned || state.failed || !chunk.length) return
      size[stream] += Buffer.byteLength(chunk)
      if (size[stream] > MAX_OUTPUT_BYTES) failed()
      else state.output[stream].push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk))
    })
  }
  const token: PreparedServiceStarter = Object.freeze({ [preparedStarter]: true as const })
  handoffs.set(token, state)
  return token
}

export type NativeServiceLauncher = (params: unknown, deadline: number) => Promise<{ stdout: string; stderr: string }>

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_TIMEOUT_MS = 30_000

/** Private native-parent/manager capability for the selected CLI's official
 * service start only. Command construction and authorization remain with the
 * host/WSL lifecycle caller; this is not a public arbitrary-execution route.
 * The POSIX default uses a separate process group. Windows has no default:
 * detached alone does not escape Job containment. Never adopt daemon handles
 * into backend cleanup or retry a failed launch with a different spawn path. */
export function createNativeServiceLauncher(
  spawnOutsideBackendContainment?: SpawnOutsideBackendContainment,
): NativeServiceLauncher {
  const launch = spawnOutsideBackendContainment ?? spawnPosixService
  return (params, deadline) => {
    const value = params as NativeServiceStartRequest | null
    const now = Date.now()
    const timeout = Math.min(MAX_TIMEOUT_MS, deadline - now)
    const expiresAt = now + timeout
    if (!value || typeof value.file !== "string" || !value.file || !Array.isArray(value.args)
      || value.args.some(arg => typeof arg !== "string") || typeof value.cwd !== "string"
      || !value.env || typeof value.env !== "object" || Array.isArray(value.env)
      || Object.values(value.env).some(item => typeof item !== "string")
      || typeof value.windowsVerbatimArguments !== "boolean" || !Number.isFinite(timeout) || timeout <= 0) {
      return Promise.reject(new Error("Invalid or expired OpenCode service start request"))
    }
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let settled = false
      let handoff: StarterHandoff | undefined
      const finish = (success: boolean) => {
        if (settled) return
        success = success && Date.now() < expiresAt
        settled = true
        clearTimeout(timer)
        const result = success && handoff ? {
          stdout: Buffer.concat(handoff.output.stdout).toString("utf8"),
          stderr: Buffer.concat(handoff.output.stderr).toString("utf8"),
        } : undefined
        if (handoff) { handoff.changed = undefined; handoff.cleanup(success) }
        if (result) resolve(result)
        else reject(new Error("OpenCode service start failed"))
      }
      // One budget covers pending preparation, spawn, output and close.
      const timer = setTimeout(() => finish(false), Math.max(0, expiresAt - Date.now()))
      const observe = (token: PreparedServiceStarter) => {
        const state = handoffs.get(token)
        if (!state) throw new Error("Prepared service starter required")
        handoffs.delete(token)
        handoff = state
        // Captures/listeners stay installed across handoff. Never replay chunks
        // into a second counter or depend on already-drained child Readables.
        const changed = () => {
          if (state.failed || Date.now() >= expiresAt) finish(false)
          else if (state.closed && state.starter.stdout.readableEnded && state.starter.stderr.readableEnded) finish(state.code === 0)
        }
        state.changed = changed
        if (settled) { state.changed = undefined; state.cleanup(false) }
        else changed()
      }
      try {
        const started = launch(value.file, value.args, {
          cwd: value.cwd, env: value.env, windowsVerbatimArguments: value.windowsVerbatimArguments,
          windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
        }, expiresAt)
        if ("then" in started) void started.then(observe).catch(() => finish(false))
        // Prepare/observe sync starters before Node's nextTick error/auto-drain.
        else observe(prepareServiceStarter(started))
      } catch { finish(false) }
    }).catch(() => {
      // Also redact synchronous spawn/native validation failures and env NULs.
      throw new Error("OpenCode service start failed")
    })
  }
}

const spawnPosixService: SpawnOutsideBackendContainment = (file, args, options) => {
  if (process.platform === "win32") throw new Error("Native Windows service spawn capability required")
  return spawn(file, args, options)
}
