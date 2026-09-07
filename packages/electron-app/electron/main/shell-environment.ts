import { spawn } from "node:child_process"
import path from "node:path"
import { buildUserShellCommand, getUserShellEnv } from "./user-shell"

const MARKER = "\0CODENOMAD_SHELL_ENV\0"
const MAX_OUTPUT = 1024 * 1024
const TIMEOUT_MS = 3000

export interface ShellEnvironment {
  executable: string
  env: NodeJS.ProcessEnv
}

/** Null means an incomplete frame; invalid complete frames are rejected. */
export function parseShellEnvironment(output: string): ShellEnvironment | null {
  const marker = output.indexOf(MARKER)
  if (marker < 0) return null
  const start = marker + MARKER.length
  const end = output.indexOf("\0", start)
  if (end < 0) return null
  const result = JSON.parse(output.slice(start, end))
  if (!result || typeof result.executable !== "string" || !path.posix.isAbsolute(result.executable) || result.executable.includes("\0")
    || !result.env || typeof result.env !== "object" || Array.isArray(result.env)
    || Object.entries(result.env).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0"))) {
    throw new Error("Invalid shell environment")
  }
  return result
}

export function shellEnvironmentScript(node: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  return `exec ${quote(node)} -e ${quote("process.stdout.write('\\0CODENOMAD_SHELL_ENV\\0'+JSON.stringify({executable:process.execPath,env:process.env})+'\\0')")}`
}

/** Optional, bounded discovery; the backend itself must always be spawned directly. */
export function resolveShellEnvironment(node: string, signal: AbortSignal): Promise<ShellEnvironment> {
  signal.throwIfAborted()
  const { command, args } = buildUserShellCommand(shellEnvironmentScript(node))
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...getUserShellEnv(), ELECTRON_RUN_AS_NODE: "1" },
      detached: true, // A new session: no controlling TTY, isolated probe process group.
    })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error, environment?: ShellEnvironment) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL") } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code !== "ESRCH") error = new Error("Shell environment cleanup failed")
        }
      }
      child.stdout.destroy()
      if (error) return reject(error)
      if (environment) resolve(environment)
      else reject(new Error("Shell environment unavailable"))
    }
    const onAbort = () => finish(new Error("Shell environment discovery cancelled"))
    const timeout = setTimeout(() => finish(new Error("Shell environment discovery timed out")), TIMEOUT_MS)
    signal.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT) return finish(new Error("Shell environment output exceeded limit"))
      chunks.push(chunk)
      try {
        const environment = parseShellEnvironment(Buffer.concat(chunks).toString("utf8"))
        if (environment) finish(undefined, environment)
      } catch {
        // Do not surface JSON parser errors: they may contain environment secrets.
        finish(new Error("Shell environment unavailable"))
      }
    })
    child.stdout.on("end", () => finish())
    child.stdout.on("error", () => finish(new Error("Shell environment read failed")))
    child.on("error", () => finish(new Error("Shell environment spawn failed")))
    if (signal.aborted) onAbort()
  })
}
