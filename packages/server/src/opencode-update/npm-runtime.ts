import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createInstallerDirectory, InstallationInterruptedError } from "./installation-lock"

/** npm in Electron resources, or beside the Node runtime: Tauri's bundled Node or a
 * standalone server's own Node. */
export function bundledNpm(execPath = process.execPath,
  resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  target = `${process.platform}-${process.arch}`): string | undefined {
  const directory = path.dirname(execPath)
  const candidates = [...(resourcesPath ? [path.join(resourcesPath, "node", target, "npm", "bin", "npm-cli.js")] : []),
    path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]
  return candidates.find(candidate => existsSync(candidate))
}

/** npm lifecycle scripts invoke `node` by name. Tauri's Node already answers to
 * it beside npm; Electron's executable (CodeNomad) needs a scoped `node` command. */
export function npmNeedsNodeCommand(node: string, platform: NodeJS.Platform): boolean {
  const name = (platform === "win32" ? path.win32 : path.posix).basename(node)
  return platform === "win32" ? name.toLowerCase() !== "node.exe" : name !== "node"
}

/** Electron is a GUI executable: on Windows npm and lifecycle scripts it runs have
 * no console, so every console program they start (npm's script shell first)
 * would open a visible console. Loaded with --require, this hides them; async
 * spawns all pass through ChildProcess.prototype.spawn. */
const HIDE_CHILD_WINDOWS = [
  "const { ChildProcess } = require(\"child_process\")",
  "const spawn = ChildProcess.prototype.spawn",
  "ChildProcess.prototype.spawn = function (options) { return spawn.call(this, { ...options, windowsHide: true }) }",
  "",
].join("\n")

/** Writes Electron's `node` command and returns the runtime arguments npm itself needs. */
export async function writeNpmNodeCommand(directory: string, node: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string[]> {
  env.CODENOMAD_NPM_NODE = node
  if (platform !== "win32") {
    await writeFile(path.join(directory, "node"), '#!/bin/sh\nexec "$CODENOMAD_NPM_NODE" "$@"\n', { mode: 0o700 })
    return []
  }
  const preload = path.join(directory, "hide-child-windows.cjs")
  await writeFile(preload, HIDE_CHILD_WINDOWS)
  env.CODENOMAD_NPM_PRELOAD = preload
  await writeFile(path.join(directory, "node.cmd"), '@echo off\r\n"%CODENOMAD_NPM_NODE%" --require "%CODENOMAD_NPM_PRELOAD%" %*\r\n')
  return ["--require", preload]
}

/** Runs npm for the locked `prefix`; Electron's `node` command lives in that prefix. */
export async function executeNpm(node: string, args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
  prefix: string, execute = executeInstaller): Promise<void> {
  const directory = npmNeedsNodeCommand(node, platform) ? await createInstallerDirectory(prefix, "npm") : undefined
  let retain = false
  try {
    const childEnv = { ...env }
    const runtimeArgs = directory ? await writeNpmNodeCommand(directory, node, childEnv, platform) : []
    const key = Object.keys(childEnv).find(key => key.toLowerCase() === "path") ?? "PATH"
    childEnv[key] = [...(directory ? [directory] : []), path.dirname(node), childEnv[key] || ""].join(platform === "win32" ? ";" : ":")
    await execute(node, [...runtimeArgs, ...args], childEnv, directory ? { cwd: directory } : undefined)
  } catch (error) {
    retain = error instanceof InstallationInterruptedError
    throw error
  } finally {
    if (directory && !retain) await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
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
