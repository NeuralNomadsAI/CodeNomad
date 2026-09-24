import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

/** npm from the official Node archive, beside the backend runtime on both hosts. */
export function bundledNpm(execPath = process.execPath): string | undefined {
  const directory = path.dirname(execPath)
  const candidates = [path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]
  return candidates.find(candidate => existsSync(candidate))
}

export function executeInstaller(file: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, cwd, windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 }, error => {
      // Do not return npm's environment/config diagnostics to the browser.
      if (error) reject(new Error(`OpenCode installation failed (${error.killed ? "timeout" : error.code ?? "execution"})`))
      else resolve()
    })
  })
}
