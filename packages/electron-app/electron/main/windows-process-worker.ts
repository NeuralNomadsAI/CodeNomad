import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type { AsyncCommandRunner } from "./process-stop"
import { windowsNativeProcesses } from "./windows-process-tree"

/** Compile once alongside CLI startup; shutdown requests only pay native-call cost. */
export class WindowsProcessWorker {
  private readonly child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${windowsNativeProcesses}
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
  private closed = false
  private markReady!: (ready: boolean) => void
  private readonly ready = new Promise<boolean>((resolve) => { this.markReady = resolve })

  constructor() {
    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", (line) => {
      if (line === "ready") { this.markReady(true); return }
      try {
        const result = JSON.parse(line)
        if (typeof result.status !== "number" || typeof result.stdout !== "string" || typeof result.stderr !== "string") throw new Error("Invalid response")
        this.pending.shift()?.(result)
      } catch { this.dispose() }
    })
    this.child.once("error", () => this.dispose())
    this.child.once("exit", () => { lines.close(); this.dispose() })
    this.child.stdin.on("error", () => this.dispose())
  }

  readonly run: AsyncCommandRunner = (_command, args, options) => {
    const script = args.at(-1)
    if (this.closed || !script?.startsWith(windowsNativeProcesses) || options.timeout <= 0) {
      return { status: null, stdout: "", stderr: "Process worker unavailable" }
    }
    return new Promise((resolve) => {
      let expired = false
      let sent = false
      const timer = setTimeout(() => {
        expired = true
        if (sent) this.dispose()
        resolve({ status: null, stdout: "", stderr: "Process worker deadline exceeded" })
      }, options.timeout)
      void this.ready.then((ready) => {
        if (expired) return
        if (!ready || this.closed) { clearTimeout(timer); resolve({ status: null, stdout: "", stderr: "Process worker closed" }); return }
        sent = true
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
