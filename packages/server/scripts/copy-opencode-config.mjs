#!/usr/bin/env node
import { spawnSync } from "child_process"
import { cpSync, existsSync, mkdirSync, rmSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const cliRoot = path.resolve(__dirname, "..")
const sourceDir = path.resolve(cliRoot, "../opencode-config")
const targetDir = path.resolve(cliRoot, "dist/opencode-config")
const nodeModulesDir = path.resolve(sourceDir, "node_modules")
const npmExecPath = process.env.npm_execpath
const npmNodeExecPath = process.env.npm_node_execpath

if (!existsSync(sourceDir)) {
  console.error(`[copy-opencode-config] Missing source directory at ${sourceDir}`)
  process.exit(1)
}

if (!existsSync(nodeModulesDir)) {
  console.log(`[copy-opencode-config] Installing opencode-config dependencies in ${sourceDir}`)

  const npmArgs = [
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--fund=false",
    "--audit=false",
    "--package-lock=false",
    "--workspaces=false",
  ]

  const env = { ...process.env, npm_config_workspaces: "false" }

  const npmCli = npmExecPath && npmNodeExecPath ? [npmNodeExecPath, [npmExecPath, ...npmArgs]] : null
  const result = npmCli
    ? spawnSync(npmCli[0], npmCli[1], { cwd: sourceDir, stdio: "inherit", env })
    : spawnSync("npm", npmArgs, { cwd: sourceDir, stdio: "inherit", env, shell: process.platform === "win32" })

  if (result.status !== 0) {
    if (result.error) {
      console.error("[copy-opencode-config] npm install failed to start", result.error)
    }
    console.error("[copy-opencode-config] Failed to install opencode-config dependencies")
    process.exit(result.status ?? 1)
  }
}

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(path.dirname(targetDir), { recursive: true })
cpSync(sourceDir, targetDir, { recursive: true })

console.log(`[copy-opencode-config] Copied ${sourceDir} -> ${targetDir}`)
