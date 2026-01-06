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
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"

if (!existsSync(sourceDir)) {
  console.error(`[copy-opencode-config] Missing source directory at ${sourceDir}`)
  process.exit(1)
}

if (!existsSync(nodeModulesDir)) {
  console.log(`[copy-opencode-config] Installing opencode-config dependencies in ${sourceDir}`)
  const result = spawnSync(
    npmCmd,
    [
      "install",
      "--prefix",
      sourceDir,
      "--omit=dev",
      "--ignore-scripts",
      "--fund=false",
      "--audit=false",
      "--package-lock=false",
      "--workspaces=false",
    ],
    { cwd: sourceDir, stdio: "inherit", env: { ...process.env, npm_config_workspaces: "false" } },
  )
  if (result.status !== 0) {
    console.error("[copy-opencode-config] Failed to install opencode-config dependencies")
    process.exit(result.status ?? 1)
  }
}

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(path.dirname(targetDir), { recursive: true })
cpSync(sourceDir, targetDir, { recursive: true })

console.log(`[copy-opencode-config] Copied ${sourceDir} -> ${targetDir}`)
