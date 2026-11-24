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

/** npm's `allow-scripts` value for CodeNomad's global OpenCode installation. Its
 * postinstall links the platform executable; the platform packages have no
 * install scripts. npm blocks unlisted dependency install scripts by default
 * (12+) and accepts this list per invocation for global installs, as a CLI flag
 * or as `npm_config_allow_scripts`; it is never written to an npmrc. Only this
 * exact package version is allowed. */
export function openCodeAllowScripts(version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Installation requires an exact stable OpenCode version")
  return `@opencode/cli@${version}`
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

/** Scopes npm/npx to this runtime; Electron also needs a node command and Windows preload. */
export async function writeNpmCommands(directory: string, node: string, npm: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string[]> {
  const needsNode = npmNeedsNodeCommand(node, platform)
  const hideWindows = needsNode && platform === "win32"
  env.CODENOMAD_NPM_NODE = node
  env.CODENOMAD_NPM_CLI = npm
  env.CODENOMAD_NPX_CLI = path.join(path.dirname(npm), "npx-cli.js")
  const preload = path.join(directory, "hide-child-windows.cjs")
  if (hideWindows) {
    await writeFile(preload, HIDE_CHILD_WINDOWS)
    env.CODENOMAD_NPM_PRELOAD = preload
  }
  for (const [name, cli] of [["npm", "CODENOMAD_NPM_CLI"], ["npx", "CODENOMAD_NPX_CLI"], ...(needsNode ? [["node", ""]] : [])]) {
    const command = platform === "win32"
      ? `@echo off\r\n"%CODENOMAD_NPM_NODE%" ${hideWindows ? '--require "%CODENOMAD_NPM_PRELOAD%" ' : ""}${cli ? `"%${cli}%" ` : ""}%*\r\n`
      : `#!/bin/sh\nexec "$CODENOMAD_NPM_NODE" ${cli ? `"$${cli}" ` : ""}"$@"\n`
    await writeFile(path.join(directory, name + (platform === "win32" ? ".cmd" : "")), command, { mode: 0o700 })
  }
  const key = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH"
  env[key] = [directory, path.dirname(node), env[key] || ""].join(platform === "win32" ? ";" : ":")
  return hideWindows ? ["--require", preload] : []
}

/** args starts with the selected npm-cli.js; all command adapters live in the locked prefix. */
export async function executeNpm(node: string, args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
  prefix: string, execute = executeInstaller): Promise<void> {
  const directory = await createInstallerDirectory(prefix, "npm")
  let retain = false
  try {
    const childEnv = { ...env }
    const runtimeArgs = await writeNpmCommands(directory, node, args[0]!, childEnv, platform)
    await execute(node, [...runtimeArgs, ...args], childEnv, { cwd: directory })
  } catch (error) {
    retain = error instanceof InstallationInterruptedError
    throw error
  } finally {
    if (!retain) await rm(directory, { recursive: true, force: true }).catch(() => {})
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
