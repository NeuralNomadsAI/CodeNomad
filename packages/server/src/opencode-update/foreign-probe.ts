import { execFile, spawn, type ChildProcess } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { buildSpawnSpec, parseBinaryVersion } from "../workspaces/spawn"

/** `undefined` means unknown (timed out or not probed yet): the PATH command keeps precedence. */
export type ForeignProbe = { valid: boolean; version?: string } | undefined

export const FOREIGN_PROBE_TIMEOUT_MS = 5_000
const OUTPUT_LIMIT = 64 * 1024

const results = new Map<string, { key: string; result: ForeignProbe }>()
const pending = new Map<string, { key: string; promise: Promise<ForeignProbe> }>()

/** File identity of the command and, for npm-style shims, of the executable it
 * launches. Any change invalidates a cached decision. */
function identity(command: string): string | undefined {
  try {
    const files = [realpathSync(command)]
    const spec = buildSpawnSpec(command, [])
    if (spec.args.length === 0 && spec.command !== command) files.push(realpathSync(spec.command))
    return files.map(file => { const stat = statSync(file); return `${file}:${stat.mtimeMs}:${stat.size}` }).join("|")
  } catch { return undefined }
}

/** Synchronous, spawn-free lookup for resolution paths. A miss starts a bounded
 * background probe and reports unknown. */
export function cachedForeignProbe(command: string): ForeignProbe {
  const key = identity(command)
  if (!key) return undefined
  const cached = results.get(command)
  if (cached?.key === key) return cached.result
  void probeForeignCommand(command)
  return undefined
}

/** Probes once per file identity, coalescing concurrent callers. Timeouts are
 * cached as unknown so a hanging wrapper is not re-run on every status read. */
export function probeForeignCommand(command: string, timeoutMs = FOREIGN_PROBE_TIMEOUT_MS): Promise<ForeignProbe> {
  const key = identity(command)
  if (!key) return Promise.resolve(undefined)
  const cached = results.get(command)
  if (cached?.key === key) return Promise.resolve(cached.result)
  const inflight = pending.get(command)
  if (inflight?.key === key) return inflight.promise
  const promise = boundedVersionProbe(command, timeoutMs).then(result => {
    if (identity(command) === key) results.set(command, { key, result })
    return result
  }).finally(() => { if (pending.get(command)?.promise === promise) pending.delete(command) })
  pending.set(command, { key, promise })
  return promise
}

/** Asynchronous `--version` with a deadline. On timeout or output overflow the
 * whole process tree is killed: wrappers may start descendants. */
export function boundedVersionProbe(command: string, timeoutMs: number): Promise<ForeignProbe> {
  return new Promise(resolve => {
    let spec: ReturnType<typeof buildSpawnSpec>
    try { spec = buildSpawnSpec(command, ["--version"]) } catch { return resolve({ valid: false }) }
    const posix = process.platform !== "win32"
    let child: ChildProcess
    try {
      child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, detached: posix,
        windowsVerbatimArguments: Boolean(spec.options.windowsVerbatimArguments), stdio: ["ignore", "pipe", "pipe"] })
    } catch { return resolve({ valid: false }) }
    let stdout = "", stderr = "", status: number | null = null, settled = false
    let drain: NodeJS.Timeout | undefined
    const finish = (result: ForeignProbe) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(drain)
      child.stdout?.destroy(); child.stderr?.destroy()
      resolve(result)
    }
    const abort = () => { killTree(child); finish(undefined) }
    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (stream === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8")
      if (stdout.length + stderr.length > OUTPUT_LIMIT) abort()
    }
    child.stdout?.on("data", collect("stdout"))
    child.stderr?.on("data", collect("stderr"))
    child.on("error", () => finish({ valid: false }))
    // A descendant may keep the pipes open after the probed process exits.
    child.on("exit", code => { status = code; drain = setTimeout(() => finish(parse()), 250) })
    child.on("close", code => finish(parse(code)))
    const parse = (code = status): ForeignProbe => {
      const parsed = parseBinaryVersion({ status: code, stdout, stderr })
      return parsed.valid ? { valid: true, ...(parsed.version ? { version: parsed.version } : {}) } : { valid: false }
    }
    const timer = setTimeout(abort, timeoutMs)
  })
}

function killTree(child: ChildProcess) {
  if (!child.pid) return
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {})
    return
  }
  try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
}
