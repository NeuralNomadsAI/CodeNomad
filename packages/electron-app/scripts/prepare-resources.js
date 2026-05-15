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

function copyServerArtifacts() {
  fs.rmSync(serverDest, { recursive: true, force: true })
  fs.mkdirSync(serverDest, { recursive: true })

  copyRequiredArtifact("package.json")
  copyRequiredArtifact("public")
  copyRequiredArtifact("node_modules")
  copyServerDist()
}

function copyRequiredArtifact(name) {
  const from = join(serverRoot, name)
  const to = join(serverDest, name)
  if (!fs.existsSync(from)) {
    throw new Error(`Missing required server artifact: ${from}`)
  }
  fs.cpSync(from, to, { recursive: true, dereference: true })
  log(`copied ${name} to Electron resources`)
}

function copyServerDist() {
  const from = join(serverRoot, "dist")
  const to = join(serverDest, "dist")
  const excludedRoots = new Set(["codenomad-server", "opencode-config", "opencode-config-template", "opencode-config.js"])

  if (!fs.existsSync(from)) {
    throw new Error(`Missing required server artifact: ${from}`)
  }

  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter(source) {
      const relative = path.relative(from, source)
      if (!relative) return true
      const [root] = relative.split(path.sep)
      if (excludedRoots.has(root)) return false
      return !/\.test\.js$/.test(path.basename(relative))
    },
  })
  log("copied filtered dist to Electron resources")
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

function removeIfExists(target) {
  if (!fs.existsSync(target)) {
    return 0
  }
  fs.rmSync(target, { recursive: true, force: true })
  return 1
}

function removeFilesMatching(root, patterns) {
  if (!fs.existsSync(root)) return 0

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
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }

      if (entry.isFile() && patterns.some((pattern) => pattern.test(entry.name))) {
        fs.rmSync(full, { force: true })
        removed += 1
      }
    }
  }

  return removed
}

function prunePackage(root, options) {
  if (!fs.existsSync(root)) return 0

  let removed = 0
  for (const relativePath of options.remove ?? []) {
    removed += removeIfExists(join(root, relativePath))
  }
  if (options.filePatterns?.length) {
    removed += removeFilesMatching(root, options.filePatterns)
  }
  return removed
}

function pruneKnownServerDependencies() {
  const root = join(serverDest, "node_modules")
  if (!fs.existsSync(root)) {
    return
  }

  let removed = 0
  const declarationAndMaps = [/\.d\.[cm]?ts$/, /\.map$/]
  const packageDocs = [/\.md$/i, /\.markdown$/i]

  removed += prunePackage(join(root, "openai"), {
    remove: ["CHANGELOG.md", "README.md", "bin", "src"],
    filePatterns: [...declarationAndMaps],
  })
  removed += prunePackage(join(root, "fastify"), {
    remove: ["docs", "examples", "integration", "test", "types", "build", "fastify.d.ts"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(join(root, "@fastify", "cors"), {
    remove: ["bench.js", "benchmark", "test", "types"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(join(root, "@fastify", "reply-from"), {
    remove: ["examples", "test", "types"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(join(root, "@fastify", "static"), {
    remove: ["example", "test", "types", "tsconfig.eslint.json"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(join(root, "pino"), {
    remove: [
      "benchmarks",
      "browser.js",
      "build",
      "docs",
      "docsify",
      "examples",
      "favicon-16x16.png",
      "favicon-32x32.png",
      "favicon.ico",
      "index.html",
      "pino-banner.png",
      "pino-logo-hire.png",
      "pino-tree.png",
      "pino.d.ts",
      "pretty-demo.png",
      "test",
      "tsconfig.json",
    ],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(join(root, "undici"), {
    remove: ["docs", "index.d.ts", "scripts", "types"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(join(root, "zod"), {
    remove: ["README.md", "src"],
    filePatterns: [...declarationAndMaps],
  })
  removed += prunePackage(join(root, "yaml"), {
    remove: ["README.md", "bin.mjs", "browser"],
    filePatterns: [...declarationAndMaps],
  })
  removed += prunePackage(join(root, "node-forge"), {
    remove: ["README.md", "flash"],
  })

  if (removed > 0) {
    log(`removed ${removed} known non-runtime files/directories from server dependencies`)
  }
}

async function main() {
  ensureServerBuild()
  ensureServerDependencies()
  copyServerArtifacts()
  stripNodeModuleBins()
  pruneKnownServerDependencies()
  await prepareBundledNodeRuntime({ resourcesRoot })
}

main().catch((error) => {
  console.error("[prepare-resources] failed:", error)
  process.exit(1)
})
