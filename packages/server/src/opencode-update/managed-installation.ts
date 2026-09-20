import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { assertSupportedOpenCode } from "../opencode/runtime-support"
import { probeBinaryVersion } from "../workspaces/spawn"

// Never place changing installations in OpenCode's recursively watched config.
export function managedInstallRoot(): string {
  return path.join(os.homedir(), ".local", "share", "codenomad", "opencode")
}

export function managedExecutable(root: string, version: string): string {
  return path.join(root, version, "node_modules", "@opencode", "cli", "bin", "opencode.exe")
}

export function readManagedExecutable(root = managedInstallRoot()): string | undefined {
  try {
    const version = readFileSync(path.join(root, "current"), "utf8").trim()
    if (!/^\d+\.\d+\.\d+$/.test(version)) return undefined
    const binary = managedExecutable(root, version)
    return existsSync(binary) ? binary : undefined
  } catch { return undefined }
}

/** npm from the official Node archive, beside the backend runtime on both hosts. */
export function bundledNpm(execPath = process.execPath): string | undefined {
  const directory = path.dirname(execPath)
  const candidates = [path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]
  return candidates.find(candidate => existsSync(candidate))
}

export function executeInstaller(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 }, error => {
      // Do not return npm's environment/config diagnostics to the browser.
      if (error) reject(new Error(`OpenCode installation failed (${error.killed ? "timeout" : error.code ?? "execution"})`))
      else resolve()
    })
  })
}

export async function installManagedOpenCode(version: string, options: {
  root?: string; node?: string; npm?: string
  execute?: typeof executeInstaller
  probe?: typeof probeBinaryVersion
  env?: NodeJS.ProcessEnv
} = {}): Promise<string> {
  assertSupportedOpenCode(version)
  const root = options.root ?? managedInstallRoot()
  const node = options.node ?? process.execPath
  const npm = options.npm ?? bundledNpm(node)
  if (!npm) throw new Error("npm is unavailable beside the CodeNomad Node runtime")
  const destination = path.join(root, version)
  const staging = path.join(root, `.install-${randomUUID()}`)
  const probe = options.probe ?? probeBinaryVersion
  await mkdir(root, { recursive: true })
  try {
    // Never overwrite the executable used by a running Windows daemon.
    const existing = probe(managedExecutable(root, version))
    if (!existing.valid || existing.version !== version) {
      await mkdir(staging)
      const env = { ...(options.env ?? process.env) }
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH"
      env[pathKey] = `${path.dirname(node)}${path.delimiter}${env[pathKey] ?? ""}`
      await (options.execute ?? executeInstaller)(node, [npm, "install", "--prefix", staging,
        "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", `@opencode/cli@${version}`], env)
      const stagedBinary = path.join(staging, "node_modules", "@opencode", "cli", "bin", "opencode.exe")
      const result = probe(stagedBinary)
      if (!result.valid || result.version !== version) throw new Error("Installed OpenCode version verification failed")
      await rename(staging, destination).catch(error => {
        // A second backend can finish the same exact version first. Accept only
        // a verified winner; never remove or overwrite an existing executable.
        const installed = probe(managedExecutable(root, version))
        if (!installed.valid || installed.version !== version) throw error
      })
    }
    const marker = path.join(root, `.current-${randomUUID()}`)
    await writeFile(marker, version, "utf8")
    try { await rename(marker, path.join(root, "current")) }
    finally { await rm(marker, { force: true }) }
    return managedExecutable(root, version)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
