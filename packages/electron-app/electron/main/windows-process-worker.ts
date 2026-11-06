import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { runCommand, type AsyncCommandRunner } from "./process-stop"
import { windowsNativeProcesses } from "./windows-process-tree"

class WorkerSession {
  readonly child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${windowsNativeProcesses}
[Console]::WriteLine('ready')
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    $output = & ([scriptblock]::Create($script))
    @{ status = 0; stdout = [string]($output -join "\n"); stderr = '' } | ConvertTo-Json -Compress
  } catch {
    @{ status = 1; stdout = ''; stderr = [string]$_ } | ConvertTo-Json -Compress
  }
}`], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] })
  private readonly pending: Array<(result: { status: number | null; stdout: string; stderr: string }) => void> = []
  closed = false
  unavailable = false
  initialized = false
  private markReady!: (ready: boolean) => void
  private readonly ready = new Promise<boolean>((resolve) => { this.markReady = resolve })

  constructor() {
    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", (line) => {
      if (line === "ready") { this.initialized = true; this.markReady(true); return }
      try {
        const result = JSON.parse(line)
        if (typeof result.status !== "number" || typeof result.stdout !== "string" || typeof result.stderr !== "string") throw new Error("Invalid response")
        this.pending.shift()?.(result)
      } catch { this.dispose() }
    })
    const exited = () => {
      if (!this.closed) this.unavailable = !this.initialized
      lines.close()
      this.dispose()
    }
    this.child.once("error", exited)
    this.child.once("exit", exited)
    this.child.stdin.on("error", () => this.dispose())
  }

  readonly run: AsyncCommandRunner = (_command, args, options) => {
    const script = args.at(-1)
    if (this.closed || !script?.startsWith(windowsNativeProcesses) || options.timeout <= 0) {
      return { status: null, stdout: "", stderr: "Process worker unavailable" }
    }
    return new Promise((resolve) => {
      let expired = false
      const timer = setTimeout(() => {
        expired = true
        this.dispose()
        resolve({ status: null, stdout: "", stderr: "Process worker deadline exceeded" })
      }, options.timeout)
      void this.ready.then((ready) => {
        if (expired) return
        if (!ready || this.closed) { clearTimeout(timer); resolve({ status: null, stdout: "", stderr: "Process worker closed" }); return }
        this.pending.push((result) => { clearTimeout(timer); resolve(result) })
        this.child.stdin.write(Buffer.from(script.slice(windowsNativeProcesses.length)).toString("base64") + "\n")
      })
    })
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.markReady(false)
    this.child.kill()
    for (const settle of this.pending.splice(0)) settle({ status: null, stdout: "", stderr: "Process worker closed" })
  }
}

/** Native compilation stays off the startup path. A failed session is replaced
 * on its next request; a failed compiler uses the cmdlet fallback for this backend. */
export class WindowsProcessWorker {
  private session = new WorkerSession()
  private disposed = false
  private get child() { return this.session.child }

  readonly run: AsyncCommandRunner = async (command, args, options) => {
    if (this.disposed || options.timeout <= 0) return { status: null, stdout: "", stderr: "Process worker unavailable" }
    const deadlineAt = Date.now() + options.timeout
    if (this.session.closed && !this.session.unavailable) this.session = new WorkerSession()
    // Final enforcement uses an already-warm helper or cmdlets, never a cold
    // compiler. The replacement can warm alongside the graceful-stop window.
    const result = options.windowsNativeReadyOnly && !this.session.initialized
      ? { status: null, stdout: "", stderr: "Process worker warming" }
      : await this.session.run(command, args, { ...options,
          // Leave time for cmdlets when compilation or a warm native call hangs.
          timeout: Math.min(deadlineAt - Date.now(), options.windowsFallbackScript
            ? options.windowsNativeReadyOnly ? 1_000 : 10_000
            : options.timeout),
        })
    const timeout = deadlineAt - Date.now()
    if (result.status === 0 || !options.windowsFallbackScript || timeout <= 0 || this.disposed) return result
    return runCommand(command, [...args.slice(0, -1), options.windowsFallbackScript], { ...options, timeout })
  }

  dispose(): void {
    this.disposed = true
    this.session.dispose()
  }
}
