#!/usr/bin/env node
import { readdirSync, renameSync, rmSync, mkdirSync } from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const serverRoot = path.resolve(__dirname, "..")
const workspaceRoot = path.resolve(serverRoot, "../..")
const pluginRoot = path.resolve(serverRoot, "../opencode-plugin")
const targetDir = path.resolve(serverRoot, "dist/opencode-plugin")
const targetTarballName = "codenomad-opencode-plugin.tgz"
const pluginWorkspace = "@codenomad/codenomad-opencode-plugin"
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"

function run(command, args, options) {
  const result = spawnSync(command, args, {
    stdio: options?.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
    encoding: "utf8",
    ...options,
  })

  if (result.error) {
    console.error(`[package-opencode-plugin] ${command} failed to start`, result.error)
    process.exit(1)
  }

  if (result.status !== 0) {
    console.error(`[package-opencode-plugin] ${command} exited with code ${result.status ?? 1}`)
    process.exit(result.status ?? 1)
  }

  return result.stdout ?? ""
}

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })

console.log(`[package-opencode-plugin] Building ${pluginWorkspace}`)
run(npmCommand, ["run", "build", "--workspace", pluginWorkspace], { cwd: workspaceRoot })

console.log(`[package-opencode-plugin] Packing ${pluginWorkspace}`)
run(npmCommand, ["pack", "--pack-destination", targetDir], { cwd: pluginRoot, capture: true })

const tarballs = readdirSync(targetDir).filter((name) => name.endsWith(".tgz"))
if (tarballs.length !== 1) {
  console.error(`[package-opencode-plugin] Expected exactly one packed plugin tarball in ${targetDir}, found ${tarballs.length}`)
  process.exit(1)
}

const packedTarball = path.join(targetDir, tarballs[0])
const targetTarball = path.join(targetDir, targetTarballName)
if (packedTarball !== targetTarball) {
  renameSync(packedTarball, targetTarball)
}

console.log(`[package-opencode-plugin] Packed ${targetTarball}`)
