import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { InstallationInterruptedError } from "./installation-lock"

/** npm from the official Node archive, beside the backend runtime on both hosts. */
export function bundledNpm(execPath = process.execPath): string | undefined {
  const directory = path.dirname(execPath)
  const candidates = [path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]
  return candidates.find(candidate => existsSync(candidate))
}

export function executeInstaller(file: string, args: string[], env: NodeJS.ProcessEnv,
  options: { cwd?: string; timeout?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, cwd: options.cwd, windowsHide: true, timeout: options.timeout ?? 300_000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      // Do not return npm's environment/config diagnostics to the browser.
      // A timeout/output-limit kill may leave npm descendants running. Keep the
      // installation fenced rather than treating parent exit as tree exit.
      if (error && (error.killed || error.signal || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) reject(new InstallationInterruptedError())
      else if (error) {
        // Only npm's symbolic error code (EPERM, EBUSY, ...) is retained for classification.
        const npmCode = String(stderr ?? "").match(/^npm (?:error|ERR!) code ([A-Z][A-Z0-9_]{1,31})\r?$/m)?.[1]
        reject(Object.assign(new Error(`OpenCode installation failed (${error.code ?? "execution"})`), npmCode ? { npmCode } : {}))
      }
      else resolve()
    })
  })
}
