#!/usr/bin/env node

import fs from "fs"
import path, { join } from "path"
import { spawnSync } from "child_process"
import { createRequire } from "module"
import { fileURLToPath } from "url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const require = createRequire(import.meta.url)
const appDir = join(__dirname, "..")
const workspaceRoot = join(appDir, "..", "..")
const serverRoot = join(appDir, "..", "server")
const resourcesRoot = join(appDir, "electron", "resources")
const serverDest = join(resourcesRoot, "server")
const npmExecPath = process.env.npm_execpath
const npmNodeExecPath = process.env.npm_node_execpath
const { prepareBundledNodeRuntime } = require(join(workspaceRoot, "scripts", "prepare-node-runtime.cjs"))
const { copyPackagedServerResources } = require(join(workspaceRoot, "scripts", "desktop-server-resources.cjs"))

const serverDepsMarker = join(serverRoot, "node_modules", "fastify", "package.json")

function log(message) {
  console.log(`[prepare-resources] ${message}`)
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
  const npmArgs = [
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--workspaces=false",
    "--package-lock=false",
    "--install-strategy=shallow",
    "--fund=false",
    "--audit=false",
  ]

  const env = {
    ...process.env,
    PATH: `${join(workspaceRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    npm_config_workspaces: "false",
  }

  const npmCli = npmExecPath && npmNodeExecPath ? [npmNodeExecPath, [npmExecPath, ...npmArgs]] : null
  const result = npmCli
    ? spawnSync(npmCli[0], npmCli[1], { cwd: serverRoot, stdio: "inherit", env })
    : spawnSync("npm", npmArgs, { cwd: serverRoot, stdio: "inherit", env, shell: process.platform === "win32" })

  if (result.status !== 0) {
    if (result.error) {
      throw result.error
    }
    throw new Error(`npm install exited with code ${result.status ?? 1}`)
  }
}

async function main() {
  ensureServerBuild()
  ensureServerDependencies()
  copyPackagedServerResources({ serverRoot, serverDest, log })
  await prepareBundledNodeRuntime({ resourcesRoot })
}

main().catch((error) => {
  console.error("[prepare-resources] failed:", error)
  process.exit(1)
})
