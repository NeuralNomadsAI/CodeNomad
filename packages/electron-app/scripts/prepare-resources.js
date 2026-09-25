#!/usr/bin/env node

import fs from "fs"
import { join } from "path"
import { createRequire } from "module"
import { fileURLToPath } from "url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const require = createRequire(import.meta.url)
const appDir = join(__dirname, "..")
const workspaceRoot = join(appDir, "..", "..")
const serverRoot = join(appDir, "..", "server")
const resourcesRoot = join(appDir, "electron", "resources")
const serverDest = join(resourcesRoot, "server")
const { prepareBundledNodeRuntime } = require(join(workspaceRoot, "scripts", "prepare-node-runtime.cjs"))
const { copyPackagedServerResources, stagePackagedServer } = require(join(workspaceRoot, "scripts", "desktop-server-resources.cjs"))

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

async function main() {
  ensureServerBuild()
  const staged = stagePackagedServer({ workspaceRoot, serverRoot, log })
  try {
    copyPackagedServerResources({ serverRoot: staged.stagedServerRoot, serverDest, log })
  } finally {
    fs.rmSync(staged.stagingRoot, { recursive: true, force: true })
  }
  await prepareBundledNodeRuntime({ resourcesRoot, target: staged.target })
}

main().catch((error) => {
  console.error("[prepare-resources] failed:", error)
  process.exit(1)
})
