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
const standaloneMarker = join(serverRoot, "dist", process.platform === "win32" ? "codenomad-server.exe" : "codenomad-server")

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

function ensureStandaloneServerBuild() {
  log("building standalone server executable")
  const result = spawnSync(
    "npm",
    ["run", "build:standalone", "--workspace", "@neuralnomads/codenomad"],
    {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${join(workspaceRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      shell: process.platform === "win32",
    },
  )

  if (result.status !== 0) {
    if (result.error) {
      throw result.error
    }
    throw new Error(`standalone server build exited with code ${result.status ?? 1}`)
  }

  if (!fs.existsSync(standaloneMarker)) {
    throw new Error(`Standalone server executable missing after build: ${standaloneMarker}`)
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

function ensureEsbuildPlatformBinary() {
  const platformKey = `${process.platform}-${process.arch}`
  const platformPackages = {
    "linux-x64": "@esbuild/linux-x64",
    "linux-arm64": "@esbuild/linux-arm64",
    "darwin-arm64": "@esbuild/darwin-arm64",
    "darwin-x64": "@esbuild/darwin-x64",
    "win32-arm64": "@esbuild/win32-arm64",
    "win32-x64": "@esbuild/win32-x64",
  }

  const pkgName = platformPackages[platformKey]
  if (!pkgName) {
    return
  }

  const platformPackagePath = join(workspaceRoot, "node_modules", ...pkgName.split("/"))
  if (fs.existsSync(platformPackagePath)) {
    return
  }

  let esbuildVersion = ""
  try {
    esbuildVersion = JSON.parse(fs.readFileSync(join(workspaceRoot, "node_modules", "esbuild", "package.json"), "utf-8")).version ?? ""
  } catch {
    // leave version empty; fallback install will use latest compatible
  }

  const packageSpec = esbuildVersion ? `${pkgName}@${esbuildVersion}` : pkgName
  log("installing esbuild platform binary (optional dep workaround)")

  const result = spawnSync("npm", ["install", packageSpec, "--no-save", "--ignore-scripts", "--fund=false", "--audit=false"], {
    cwd: workspaceRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  })

  if (result.status !== 0) {
    if (result.error) {
      throw result.error
    }
    throw new Error(`esbuild platform install exited with code ${result.status ?? 1}`)
  }
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
  ensureStandaloneServerBuild()
  ensureServerDependencies()
  ensureEsbuildPlatformBinary()
  copyServerArtifacts()
  stripNodeModuleBins()
}

main().catch((error) => {
  console.error("[prepare-resources] failed:", error)
  process.exit(1)
})
