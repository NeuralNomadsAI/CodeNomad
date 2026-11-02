#!/usr/bin/env node

import { spawn } from "child_process"
import { existsSync, readFileSync } from "fs"
import path, { join } from "path"
import { fileURLToPath } from "url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const appDir = join(__dirname, "..")
const workspaceRoot = join(appDir, "..", "..")

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx"
const nodeModulesPath = join(appDir, "node_modules")
const workspaceNodeModulesPath = join(workspaceRoot, "node_modules")

const platforms = {
  mac: {
    jobs: [
      { args: ["--mac", "--x64"], nodeTarget: "darwin-x64" },
      { args: ["--mac", "--arm64"], nodeTarget: "darwin-arm64" },
    ],
    description: "macOS (Intel & Apple Silicon)",
  },
  "mac-x64": {
    jobs: [{ args: ["--mac", "--x64"], nodeTarget: "darwin-x64" }],
    description: "macOS (Intel only)",
  },
  "mac-arm64": {
    jobs: [{ args: ["--mac", "--arm64"], nodeTarget: "darwin-arm64" }],
    description: "macOS (Apple Silicon only)",
  },
  win: {
    jobs: [{ args: ["--win", "--x64"], nodeTarget: "win32-x64" }],
    description: "Windows (x64)",
  },
  "win-arm64": {
    jobs: [{ args: ["--win", "--arm64"], nodeTarget: "win32-arm64" }],
    description: "Windows (ARM64)",
  },
  linux: {
    jobs: [{ args: ["--linux", "--x64"], nodeTarget: "linux-x64" }],
    description: "Linux (x64)",
  },
  "linux-arm64": {
    jobs: [{ args: ["--linux", "--arm64"], nodeTarget: "linux-arm64" }],
    description: "Linux (ARM64)",
  },
  "linux-rpm": {
    jobs: [
      { args: ["--linux", "rpm", "--x64"], nodeTarget: "linux-x64" },
      { args: ["--linux", "rpm", "--arm64"], nodeTarget: "linux-arm64" },
    ],
    description: "Linux RPM packages (x64 & ARM64)",
  },
  all: {
    jobs: [
      { args: ["--mac", "--x64"], nodeTarget: "darwin-x64" },
      { args: ["--mac", "--arm64"], nodeTarget: "darwin-arm64" },
      { args: ["--win", "--x64"], nodeTarget: "win32-x64" },
      { args: ["--win", "--arm64"], nodeTarget: "win32-arm64" },
      { args: ["--linux", "--x64"], nodeTarget: "linux-x64" },
      { args: ["--linux", "--arm64"], nodeTarget: "linux-arm64" },
    ],
    description: "All platforms (macOS, Windows, Linux)",
  },
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, NODE_PATH: nodeModulesPath, ...(options.env || {}) }
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH"

    const binPaths = [
      join(nodeModulesPath, ".bin"),
      join(workspaceNodeModulesPath, ".bin"),
    ]

    env[pathKey] = `${binPaths.join(path.delimiter)}${path.delimiter}${env[pathKey] ?? ""}`

    const spawnOptions = {
      cwd: appDir,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
      env,
    }

    const child = spawn(command, args, spawnOptions)

    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(undefined)
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`))
      }
    })
  })
}

// electron-builder writes the numeric Windows form of the version
// (major.minor.patch.0) as the executable's ProductVersion string, while
// Tauri's binaries carry the full version; SignPath Foundation requires one
// product version across the signed binaries of a release. shortVersionWindows
// feeds the resource edit electron-builder performs before it signs: rcedit
// stores the full string and its numeric prefix (major.minor.patch.0) in the
// fixed version fields, as Tauri does.
function windowsVersionArgs(args, version) {
  return args.includes("--win") ? [`-c.extraMetadata.shortVersionWindows=${version}`] : []
}

function printAvailablePlatforms() {
  console.error(`\nAvailable platforms:`)
  for (const [name, cfg] of Object.entries(platforms)) {
    console.error(`  - ${name.padEnd(12)} : ${cfg.description}`)
  }
}

async function build(platform) {
  const config = platforms[platform]

  if (!config) {
    console.error(`❌ Unknown platform: ${platform}`)
    printAvailablePlatforms()
    process.exit(1)
  }

  console.log(`\n🔨 Building for: ${config.description}\n`)

  try {
    console.log("📦 Step 1/3: Building CLI dependency...\n")
    await run(npmCmd, ["run", "build", "--workspace", "@neuralnomads/codenomad"], {
      cwd: workspaceRoot,
      env: { NODE_PATH: workspaceNodeModulesPath },
    })

    console.log("\n📦 Step 2/3: Building Electron app...\n")
    await run(npxCmd, ["electron-vite", "build"])

    console.log("\n📦 Step 3/3: Packaging binaries...\n")
    const distPath = join(appDir, "dist")
    if (!existsSync(distPath)) {
      throw new Error("dist/ directory not found. Build failed.")
    }

    for (const job of config.jobs) {
      console.log(`\n📦 Preparing resources for ${job.nodeTarget}...\n`)
      await run(process.execPath, [join(appDir, "scripts", "prepare-resources.js")], {
        cwd: workspaceRoot,
        shell: false,
        env: { NODE_PATH: workspaceNodeModulesPath, CODENOMAD_NODE_TARGET: job.nodeTarget },
      })

      console.log(`\n🔎 Validating resources for ${job.nodeTarget}...\n`)
      await run(process.execPath, [
        join(workspaceRoot, "scripts", "smoke-packaged-resources.cjs"),
        "--resources",
        join(appDir, "electron", "resources"),
        "--loading",
        join(appDir, "dist", "renderer"),
        "--target",
        job.nodeTarget,
      ], {
        cwd: workspaceRoot,
        shell: false,
      })

      console.log(`\n📦 Packaging ${job.nodeTarget}...\n`)
      const { version } = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"))
      await run(npxCmd, ["electron-builder", "--publish=never", ...job.args, ...windowsVersionArgs(job.args, version)], {
        env: { CODENOMAD_NODE_TARGET: job.nodeTarget },
      })
    }

    console.log("\n✅ Build complete!")
    console.log(`📁 Binaries available in: ${join(appDir, "release")}\n`)
  } catch (error) {
    console.error("\n❌ Build failed:", error)
    process.exit(1)
  }
}

const platform = process.argv[2] || "mac"

console.log(`
╔════════════════════════════════════════╗
║   CodeNomad - Binary Builder          ║
╚════════════════════════════════════════╝
`)

await build(platform)
