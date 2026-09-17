import { spawn } from "node:child_process"

interface ServiceStartRequest {
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
  windowsVerbatimArguments: boolean
}

/** Called only through the private backend stdout/stdin bridge, never renderer IPC.
 * The CLI owns the daemon; neither it nor its starter is a backend descendant. */
export function startNativeService(params: unknown, deadline: number): Promise<{ stdout: string; stderr: string }> {
  const value = params as ServiceStartRequest | null
  const timeout = Math.min(30_000, deadline - Date.now())
  if (!value || typeof value.file !== "string" || !value.file || !Array.isArray(value.args)
    || value.args.some(arg => typeof arg !== "string") || typeof value.cwd !== "string"
    || !value.env || typeof value.env !== "object" || Array.isArray(value.env)
    || Object.values(value.env).some(item => typeof item !== "string")
    || typeof value.windowsVerbatimArguments !== "boolean" || !Number.isFinite(timeout) || timeout <= 0) {
    return Promise.reject(new Error("Invalid or expired OpenCode service start request"))
  }
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(value.file, value.args, {
      cwd: value.cwd, env: value.env, windowsVerbatimArguments: value.windowsVerbatimArguments,
      windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    })
    let settled = false
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const size = { stdout: 0, stderr: 0 }
    const finish = (success: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!success && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      child.stdout.destroy()
      child.stderr.destroy()
      // CLI output and environment may contain secrets. Never return them on failure.
      if (success) resolve({ stdout: Buffer.concat(output.stdout).toString("utf8"), stderr: Buffer.concat(output.stderr).toString("utf8") })
      else reject(new Error("OpenCode service start failed"))
    }
    const timer = setTimeout(() => finish(false), timeout)
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].on("data", (chunk: Buffer) => {
        if (settled) return
        size[stream] += chunk.length
        if (size[stream] > 64 * 1024) finish(false)
        else output[stream].push(chunk)
      })
    }
    child.once("error", () => finish(false))
    child.once("close", (code) => finish(code === 0))
  }).catch(() => {
    // Also redact synchronous spawn validation failures (for example NULs in env).
    throw new Error("OpenCode service start failed")
  })
}
