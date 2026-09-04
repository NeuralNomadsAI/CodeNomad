#!/usr/bin/env node
const fs = require("fs")
const path = require("path")
const { execFileSync, execSync } = require("child_process")
const { pathToFileURL } = require("url")

const root = path.resolve(__dirname, "..")
const workspaceRoot = path.resolve(root, "..", "..")
const serverRoot = path.resolve(root, "..", "server")
const uiRoot = path.resolve(root, "..", "ui")
const uiDist = path.resolve(uiRoot, "src", "renderer", "dist")
const serverDest = path.resolve(root, "src-tauri", "resources", "server")
const uiLoadingDest = path.resolve(root, "src-tauri", "resources", "ui-loading")
const resourcesRoot = path.resolve(root, "src-tauri", "resources")
const { prepareBundledNodeRuntime } = require(path.join(workspaceRoot, "scripts", "prepare-node-runtime.cjs"))
const { copyPackagedServerResources, stagePackagedServer } = require(path.join(workspaceRoot, "scripts", "desktop-server-resources.cjs"))

const serverPrepareUiCommand = "npm run prepare-ui --workspace @neuralnomads/codenomad"

const envWithRootBin = {
  ...process.env,
  PATH: `${path.join(workspaceRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH}`,
}

const platformKey = `${process.platform}-${process.arch}`
const platformBuildDependencies = {
  "linux-x64": "@rollup/rollup-linux-x64-gnu",
  "linux-arm64": "@rollup/rollup-linux-arm64-gnu",
  "darwin-arm64": "@rollup/rollup-darwin-arm64",
  "darwin-x64": "@rollup/rollup-darwin-x64",
  "win32-arm64": "@rollup/rollup-win32-arm64-msvc",
  "win32-x64": "@rollup/rollup-win32-x64-msvc",
}
const esbuildPlatformPackages = {
  "linux-x64": "@esbuild/linux-x64",
  "linux-arm64": "@esbuild/linux-arm64",
  "darwin-arm64": "@esbuild/darwin-arm64",
  "darwin-x64": "@esbuild/darwin-x64",
  "win32-arm64": "@esbuild/win32-arm64",
  "win32-x64": "@esbuild/win32-x64",
}

async function ensureMonacoAssets() {
  const helperPath = path.join(uiRoot, "scripts", "monaco-public-assets.js")
  const helperUrl = pathToFileURL(helperPath).href
  const { copyMonacoPublicAssets } = await import(helperUrl)
  copyMonacoPublicAssets({
    uiRendererRoot: path.join(uiRoot, "src", "renderer"),
    warn: (msg) => console.warn(`[prebuild] ${msg}`),
    sourceRoots: [
      path.resolve(workspaceRoot, "node_modules", "monaco-editor", "min", "vs"),
      path.resolve(uiRoot, "node_modules", "monaco-editor", "min", "vs"),
    ],
  })
}

function ensureServerBuild() {
  const distPath = path.join(serverRoot, "dist")
  const publicPath = path.join(serverRoot, "public")
  console.log("[prebuild] rebuilding server workspace for desktop packaging...")
  execSync("npm --workspace @neuralnomads/codenomad run build", {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${path.join(workspaceRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH}`,
    },
  })

  if (!fs.existsSync(distPath) || !fs.existsSync(publicPath)) {
    throw new Error("[prebuild] server artifacts still missing after build")
  }
}

function ensureUiBuild() {
  const loadingHtml = path.join(uiDist, "loading.html")
  if (fs.existsSync(loadingHtml)) {
    return
  }

  console.log("[prebuild] ui build missing; running workspace build...")
  execSync("npm --workspace @codenomad/ui run build", {
    cwd: workspaceRoot,
    stdio: "inherit",
  })

  if (!fs.existsSync(loadingHtml)) {
    throw new Error("[prebuild] ui loading assets missing after build")
  }
}

function syncServerUiBundle() {
  console.log("[prebuild] syncing server public UI bundle...")
  execSync(serverPrepareUiCommand, {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: envWithRootBin,
  })
}

function resolveEsbuildExecutable(rootPath, platform = process.platform, arch = process.arch) {
  const packageName = esbuildPlatformPackages[`${platform}-${arch}`]
  if (!packageName) throw new Error(`unsupported esbuild platform ${platform}-${arch}`)
  const esbuildPackagePath = require.resolve("esbuild/package.json", { paths: [rootPath] })
  const esbuildPackage = JSON.parse(fs.readFileSync(esbuildPackagePath, "utf8"))
  const platformPackagePath = require.resolve(`${packageName}/package.json`, {
    paths: [path.dirname(esbuildPackagePath)],
  })
  const platformPackage = JSON.parse(fs.readFileSync(platformPackagePath, "utf8"))
  if (platformPackage.version !== esbuildPackage.version || !platformPackage.os?.includes(platform) || !platformPackage.cpu?.includes(arch)) {
    throw new Error(`${packageName} does not match esbuild ${esbuildPackage.version} for ${platform}-${arch}`)
  }
  const executable = path.join(path.dirname(platformPackagePath), ...(platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"]))
  if (!fs.existsSync(executable)) throw new Error(`esbuild executable is missing at ${executable}`)
  return { executable, version: esbuildPackage.version }
}

function requireRootBuildDependencies() {
  const platformPackage = platformBuildDependencies[platformKey]
  if (!platformPackage) throw new Error(`[prebuild] unsupported build host ${platformKey}`)
  const dependencies = ["typescript", "@types/node-forge", "@types/yauzl", "vite", "esbuild", platformPackage]
  const missing = dependencies.filter((dependency) => {
    try {
      require.resolve(`${dependency}/package.json`, { paths: [workspaceRoot] })
      return false
    } catch {
      return true
    }
  })
  if (missing.length) {
    throw new Error(`[prebuild] missing root dependencies: ${missing.join(", ")}. Run npm ci --workspaces --include=optional from ${workspaceRoot}`)
  }
  try {
    const esbuild = resolveEsbuildExecutable(workspaceRoot)
    const installedVersion = execFileSync(esbuild.executable, ["--version"], { encoding: "utf8" }).trim()
    if (installedVersion !== esbuild.version) throw new Error(`expected ${esbuild.version}, received ${installedVersion}`)
  } catch (error) {
    throw new Error(`[prebuild] root esbuild executable is unavailable: ${error.message}. Run npm ci --workspaces --include=optional from ${workspaceRoot}`)
  }
}

function copyUiLoadingAssets() {
  const loadingSource = path.join(uiDist, "loading.html")
  const assetsSource = path.join(uiDist, "assets")

  if (!fs.existsSync(loadingSource)) {
    throw new Error("[prebuild] cannot find built loading.html")
  }

  fs.rmSync(uiLoadingDest, { recursive: true, force: true })
  fs.mkdirSync(uiLoadingDest, { recursive: true })

  fs.copyFileSync(loadingSource, path.join(uiLoadingDest, "loading.html"))
  if (fs.existsSync(assetsSource)) {
    fs.cpSync(assetsSource, path.join(uiLoadingDest, "assets"), { recursive: true })
  }

  console.log(`[prebuild] prepared UI loading assets from ${uiDist}`)
}

async function main() {
  requireRootBuildDependencies()
  await ensureMonacoAssets()
  ensureServerBuild()
  ensureUiBuild()
  syncServerUiBundle()
  const staged = stagePackagedServer({
    workspaceRoot,
    serverRoot,
    log: (message) => console.log(`[prebuild] ${message}`),
  })
  try {
    copyPackagedServerResources({
      serverRoot: staged.stagedServerRoot,
      serverDest,
      log: (message) => console.log(`[prebuild] ${message}`),
    })
  } finally {
    fs.rmSync(staged.stagingRoot, { recursive: true, force: true })
  }
  copyUiLoadingAssets()
  await prepareBundledNodeRuntime({ resourcesRoot, target: staged.target })
  execSync(
    `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(workspaceRoot, "scripts", "smoke-packaged-resources.cjs"))} --resources ${JSON.stringify(resourcesRoot)} --loading ${JSON.stringify(uiLoadingDest)}`,
    {
      cwd: workspaceRoot,
      stdio: "inherit",
    },
  )
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[prebuild] failed:", err)
    process.exit(1)
  })
}

module.exports = { resolveEsbuildExecutable }
