#!/usr/bin/env node
const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")
const { pathToFileURL } = require("url")

const root = path.resolve(__dirname, "..")
const workspaceRoot = path.resolve(root, "..", "..")
const serverRoot = path.resolve(root, "..", "server")
const uiRoot = path.resolve(root, "..", "ui")
const uiDist = path.resolve(uiRoot, "src", "renderer", "dist")
const serverDest = path.resolve(root, "src-tauri", "resources", "server")
const uiLoadingDest = path.resolve(root, "src-tauri", "resources", "ui-loading")

const sources = ["dist", "public", "node_modules", "package.json"]

const serverInstallCommand =
  "npm install --omit=dev --ignore-scripts --workspaces=false --package-lock=false --install-strategy=shallow --fund=false --audit=false"
const serverDevInstallCommand =
  "npm install --workspace @neuralnomads/codenomad --include-workspace-root=false --install-strategy=nested --fund=false --audit=false"
const uiDevInstallCommand =
  "npm install --workspace @codenomad/ui --include-workspace-root=false --install-strategy=nested --fund=false --audit=false"

const envWithRootBin = {
  ...process.env,
  PATH: `${path.join(workspaceRoot, "node_modules/.bin")}:${process.env.PATH}`,
}

const braceExpansionPath = path.join(
  serverRoot,
  "node_modules",
  "@fastify",
  "static",
  "node_modules",
  "brace-expansion",
  "package.json",
)

const viteBinPath = path.join(uiRoot, "node_modules", ".bin", "vite")

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
  if (fs.existsSync(distPath) && fs.existsSync(publicPath)) {
    return
  }

  console.log("[prebuild] server build missing; running workspace build...")
  execSync("npm --workspace @neuralnomads/codenomad run build", {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${path.join(workspaceRoot, "node_modules/.bin")}:${process.env.PATH}`,
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

function ensureServerDevDependencies() {
  if (fs.existsSync(braceExpansionPath)) {
    return
  }

  console.log("[prebuild] ensuring server build dependencies (with dev)...")
  execSync(serverDevInstallCommand, {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: envWithRootBin,
  })
}

function ensureServerDependencies() {
  if (fs.existsSync(braceExpansionPath)) {
    return
  }

  console.log("[prebuild] ensuring server production dependencies...")
  execSync(serverInstallCommand, {
    cwd: serverRoot,
    stdio: "inherit",
  })
}

function ensureUiDevDependencies() {
  if (fs.existsSync(viteBinPath)) {
    return
  }

  console.log("[prebuild] ensuring ui build dependencies...")
  execSync(uiDevInstallCommand, {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: envWithRootBin,
  })
}

function ensureRollupPlatformBinary() {
  const platformKey = `${process.platform}-${process.arch}`
  const platformPackages = {
    "linux-x64": "@rollup/rollup-linux-x64-gnu",
    "linux-arm64": "@rollup/rollup-linux-arm64-gnu",
    "darwin-arm64": "@rollup/rollup-darwin-arm64",
    "darwin-x64": "@rollup/rollup-darwin-x64",
    "win32-x64": "@rollup/rollup-win32-x64-msvc",
  }

  const pkgName = platformPackages[platformKey]
  if (!pkgName) {
    return
  }

  const platformPackagePath = path.join(workspaceRoot, "node_modules", "@rollup", pkgName.split("/").pop())
  if (fs.existsSync(platformPackagePath)) {
    return
  }

  let rollupVersion = ""
  try {
    rollupVersion = require(path.join(workspaceRoot, "node_modules", "rollup", "package.json")).version
  } catch (error) {
    // leave version empty; fallback install will use latest compatible
  }

  const packageSpec = rollupVersion ? `${pkgName}@${rollupVersion}` : pkgName

  console.log("[prebuild] installing rollup platform binary (optional dep workaround)...")
  execSync(`npm install ${packageSpec} --no-save --ignore-scripts --fund=false --audit=false`, {
    cwd: workspaceRoot,
    stdio: "inherit",
  })
}

function copyServerArtifacts() {
  fs.rmSync(serverDest, { recursive: true, force: true })
  fs.mkdirSync(serverDest, { recursive: true })

  for (const name of sources) {
    const from = path.join(serverRoot, name)
    const to = path.join(serverDest, name)
    if (!fs.existsSync(from)) {
      console.warn(`[prebuild] skipped missing ${from}`)
      continue
    }
    fs.cpSync(from, to, { recursive: true, dereference: true })
    console.log(`[prebuild] copied ${from} -> ${to}`)
  }
}

function stripNodeModuleBins() {
  const root = path.join(serverDest, "node_modules")
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
      const full = path.join(current, entry.name)
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
    console.log(`[prebuild] removed ${removed} node_modules/.bin directories`)
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

;(async () => {
  ensureServerDevDependencies()
  ensureUiDevDependencies()
  await ensureMonacoAssets()
  ensureRollupPlatformBinary()
  ensureServerDependencies()
  ensureServerBuild()
  ensureUiBuild()
  copyServerArtifacts()
  stripNodeModuleBins()
  copyUiLoadingAssets()
})().catch((err) => {
  console.error("[prebuild] failed:", err)
  process.exit(1)
})
