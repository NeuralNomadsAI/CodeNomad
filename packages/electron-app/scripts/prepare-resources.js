#!/usr/bin/env node

import fs from "fs"
import path, { join } from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const appDir = join(__dirname, "..")
const workspaceRoot = join(appDir, "..", "..")
const serverRoot = join(appDir, "..", "server")
const resourcesRoot = join(appDir, "electron", "resources")
const serverDest = join(resourcesRoot, "server")
const npmExecPath = process.env.npm_execpath
const npmNodeExecPath = process.env.npm_node_execpath

const serverSources = ["dist", "public", "node_modules", "package.json"]
const serverDepsMarker = join(serverRoot, "node_modules", "fastify", "package.json")

function log(message) {
  console.log(`[prepare-resources] ${message}`)
}

function runNpm(args, options = {}) {
  const env = {
    ...process.env,
    ...options.env,
  }

  const result = npmExecPath && npmNodeExecPath
    ? spawnSync(npmNodeExecPath, [npmExecPath, ...args], {
        ...options,
        stdio: "inherit",
        env,
      })
    : spawnSync("npm", args, {
        ...options,
        stdio: "inherit",
        env,
        shell: process.platform === "win32",
      })

  if (result.status === 0) {
    return
  }

  if (result.error) {
    throw result.error
  }

  throw new Error(`npm ${args.join(" ")} exited with code ${result.status ?? 1}`)
}

function ensureServerBuild() {
  const distPath = join(serverRoot, "dist")
  const publicPath = join(serverRoot, "public")
  if (!fs.existsSync(distPath) || !fs.existsSync(publicPath)) {
    throw new Error("Server build artifacts are missing. Run the server build before packaging Electron.")
  }
}

function ensureServerDependencies() {
  if (fs.existsSync(serverDepsMarker)) {
    return
  }

  log("installing production server dependencies")
  runNpm(
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--workspaces=false",
      "--package-lock=false",
      "--install-strategy=shallow",
      "--fund=false",
      "--audit=false",
    ],
    {
      cwd: serverRoot,
      env: {
        PATH: `${join(workspaceRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
        npm_config_workspaces: "false",
      },
    },
  )
}

function copyServerArtifacts() {
  fs.rmSync(serverDest, { recursive: true, force: true })
  fs.mkdirSync(serverDest, { recursive: true })

  for (const name of serverSources) {
    const from = join(serverRoot, name)
    const to = join(serverDest, name)
    if (!fs.existsSync(from)) {
      throw new Error(`Missing required server artifact: ${from}`)
    }
    fs.cpSync(from, to, { recursive: true, dereference: true })
    log(`copied ${name} to Electron resources`) 
  }
}

function stripNodeModuleBins() {
  const root = join(serverDest, "node_modules")
  if (!fs.existsSync(root)) {
    return
  }

  const stack = [root]
  let removed = 0

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break

    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.name === ".bin") {
        fs.rmSync(full, { recursive: true, force: true })
        removed += 1
        continue
      }

      if (entry.isDirectory()) {
        stack.push(full)
      }
    }
  }

  if (removed > 0) {
    log(`removed ${removed} node_modules/.bin directories`)
  }
}

async function main() {
  ensureServerBuild()
  ensureServerDependencies()
  copyServerArtifacts()
  stripNodeModuleBins()
}

main().catch((error) => {
  console.error("[prepare-resources] failed:", error)
  process.exit(1)
})
