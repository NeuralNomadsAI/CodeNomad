import { execFile } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdir, rename, rm, open } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { assertSupportedOpenCode } from "../opencode/runtime-support"
import { probeBinaryVersion } from "../workspaces/spawn"
import { compareVersionStrings } from "../releases/release-monitor"

// Never place changing installations in OpenCode's recursively watched config.
export function managedInstallRoot(): string {
  return path.join(os.homedir(), ".local", "share", "codenomad", "opencode")
}

export function managedExecutable(root: string, version: string): string {
  return path.join(root, version, "node_modules", "@opencode", "cli", "bin", "opencode.exe")
}

export function readManagedExecutable(root = managedInstallRoot()): string | undefined {
  // Immutable receipts make selection monotonic across backends/processes.
  // A slower older install can publish its receipt but cannot replace a newer
  // selection. Unfinished staging/version directories never count as receipts.
  let versions: string[] = []
  try { versions = readdirSync(path.join(root, "selected")) } catch { /* First installation. */ }
  try { versions.push(readFileSync(path.join(root, "current"), "utf8").trim()) } catch { /* Previous marker format is optional. */ }
  return versions.filter(version => /^\d+\.\d+\.\d+$/.test(version))
    .sort((a, b) => compareVersionStrings(b, a))
    .map(version => managedExecutable(root, version)).find(binary => existsSync(binary))
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
  // An exact stable npm spec is an installation constraint, not runtime policy.
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Installation requires an exact stable OpenCode version")
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
    const selections = path.join(root, "selected")
    await mkdir(selections, { recursive: true })
    // The filename is the entire receipt. Exclusive creation publishes it in
    // one operation and never replaces an existing same-version receipt.
    await open(path.join(selections, version), "wx").then(file => file.close()).catch(error => {
      if (error.code !== "EEXIST") throw error
    })
    return readManagedExecutable(root)!
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
