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
const resourcesRoot = path.resolve(root, "src-tauri", "resources")
const { prepareBundledNodeRuntime } = require(path.join(workspaceRoot, "scripts", "prepare-node-runtime.cjs"))

const serverInstallCommand =
  "npm install --omit=dev --ignore-scripts --workspaces=false --package-lock=false --install-strategy=shallow --fund=false --audit=false"
const serverDevInstallCommand =
  "npm install --workspace @neuralnomads/codenomad --include-workspace-root=false --install-strategy=nested --fund=false --audit=false"
const pluginDevInstallCommand =
  "npm install --workspace @codenomad/codenomad-opencode-plugin --include-workspace-root=false --install-strategy=nested --fund=false --audit=false"
const uiDevInstallCommand =
  "npm install --workspace @codenomad/ui --include-workspace-root=false --install-strategy=nested --fund=false --audit=false"
const serverPrepareUiCommand = "npm run prepare-ui --workspace @neuralnomads/codenomad"

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

const serverBuildDependencyPaths = [
  path.join(serverRoot, "node_modules", "typescript", "package.json"),
  path.join(serverRoot, "node_modules", "@types", "node-forge", "package.json"),
  path.join(serverRoot, "node_modules", "@types", "yauzl", "package.json"),
]

const pluginRoot = path.resolve(root, "..", "opencode-plugin")
const pluginBuildDependencyPaths = [
  path.join(pluginRoot, "node_modules", "typescript", "package.json"),
  path.join(pluginRoot, "node_modules", "@types", "node", "package.json"),
]

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
  console.log("[prebuild] rebuilding server workspace for desktop packaging...")
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

function syncServerUiBundle() {
  console.log("[prebuild] syncing server public UI bundle...")
  execSync(serverPrepareUiCommand, {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: envWithRootBin,
  })
}

function ensureServerDevDependencies() {
  if (serverBuildDependencyPaths.every((filePath) => fs.existsSync(filePath))) {
    return
  }

  console.log("[prebuild] ensuring server build dependencies (with dev)...")
  execSync(serverDevInstallCommand, {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: envWithRootBin,
  })
}

function ensurePluginDevDependencies() {
  if (pluginBuildDependencyPaths.every((filePath) => fs.existsSync(filePath))) {
    return
  }

  console.log("[prebuild] ensuring OpenCode plugin build dependencies...")
  execSync(pluginDevInstallCommand, {
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
    "win32-arm64": "@rollup/rollup-win32-arm64-msvc",
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

function ensureEsbuildPlatformBinary() {
  const platformKey = `${process.platform}-${process.arch}`
  const platformPackages = {
    "linux-arm": "@esbuild/linux-arm",
    "linux-arm64": "@esbuild/linux-arm64",
    "linux-ia32": "@esbuild/linux-ia32",
    "linux-x64": "@esbuild/linux-x64",
    "darwin-arm64": "@esbuild/darwin-arm64",
    "darwin-x64": "@esbuild/darwin-x64",
    "win32-arm64": "@esbuild/win32-arm64",
    "win32-ia32": "@esbuild/win32-ia32",
    "win32-x64": "@esbuild/win32-x64",
  }

  const pkgName = platformPackages[platformKey]
  if (!pkgName) {
    return
  }

  const platformPackageName = pkgName.split("/").pop()
  const platformPackagePaths = [
    path.join(serverRoot, "node_modules", "@esbuild", platformPackageName),
    path.join(workspaceRoot, "node_modules", "@esbuild", platformPackageName),
  ]
  if (platformPackagePaths.some((packagePath) => fs.existsSync(packagePath))) {
    return
  }

  let esbuildVersion = ""
  for (const baseRoot of [serverRoot, workspaceRoot]) {
    try {
      esbuildVersion = require(path.join(baseRoot, "node_modules", "esbuild", "package.json")).version
      break
    } catch (error) {
      // try the next install root; fallback install will use latest compatible
    }
  }

  const packageSpec = esbuildVersion ? `${pkgName}@${esbuildVersion}` : pkgName

  console.log("[prebuild] installing esbuild platform binary (optional dep workaround)...")
  execSync(`npm install ${packageSpec} --no-save --ignore-scripts --package-lock=false --fund=false --audit=false`, {
    cwd: workspaceRoot,
    stdio: "inherit",
  })
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
  const from = path.join(serverRoot, name)
  const to = path.join(serverDest, name)
  if (!fs.existsSync(from)) {
    throw new Error(`[prebuild] missing required server artifact: ${from}`)
  }
  fs.cpSync(from, to, { recursive: true, dereference: true })
  console.log(`[prebuild] copied ${from} -> ${to}`)
}

function copyServerDist() {
  const from = path.join(serverRoot, "dist")
  const to = path.join(serverDest, "dist")
  const excludedRoots = new Set(["codenomad-server", "opencode-config", "opencode-config-template", "opencode-config.js"])

  if (!fs.existsSync(from)) {
    throw new Error(`[prebuild] missing required server artifact: ${from}`)
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
  console.log(`[prebuild] copied filtered ${from} -> ${to}`)
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
      const full = path.join(current, entry.name)
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
    removed += removeIfExists(path.join(root, relativePath))
  }
  if (options.filePatterns?.length) {
    removed += removeFilesMatching(root, options.filePatterns)
  }
  return removed
}

function pruneKnownServerDependencies() {
  const root = path.join(serverDest, "node_modules")
  if (!fs.existsSync(root)) {
    return
  }

  let removed = 0
  const declarationAndMaps = [/\.d\.[cm]?ts$/, /\.map$/]
  const packageDocs = [/\.md$/i, /\.markdown$/i]

  removed += prunePackage(path.join(root, "openai"), {
    remove: ["CHANGELOG.md", "README.md", "bin", "src"],
    filePatterns: [...declarationAndMaps],
  })
  removed += prunePackage(path.join(root, "fastify"), {
    remove: ["docs", "examples", "integration", "test", "types", "build", "fastify.d.ts"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "@fastify", "cors"), {
    remove: ["bench.js", "benchmark", "test", "types"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "@fastify", "reply-from"), {
    remove: ["examples", "test", "types"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "@fastify", "static"), {
    remove: ["example", "test", "types", "tsconfig.eslint.json"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "pino"), {
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
  removed += prunePackage(path.join(root, "undici"), {
    remove: ["docs", "index.d.ts", "scripts", "types"],
    filePatterns: [...packageDocs],
  })
  removed += prunePackage(path.join(root, "zod"), {
    remove: ["README.md", "src"],
    filePatterns: [...declarationAndMaps],
  })
  removed += prunePackage(path.join(root, "yaml"), {
    remove: ["README.md", "bin.mjs", "browser"],
    filePatterns: [...declarationAndMaps],
  })
  removed += prunePackage(path.join(root, "node-forge"), {
    remove: ["README.md", "flash"],
  })

  if (removed > 0) {
    console.log(`[prebuild] removed ${removed} known non-runtime files/directories from server dependencies`)
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
  ensurePluginDevDependencies()
  ensureUiDevDependencies()
  await ensureMonacoAssets()
  ensureRollupPlatformBinary()
  ensureEsbuildPlatformBinary()
  ensureServerBuild()
  ensureServerDependencies()
  ensureUiBuild()
  syncServerUiBundle()
  copyServerArtifacts()
  stripNodeModuleBins()
  pruneKnownServerDependencies()
  copyUiLoadingAssets()
  await prepareBundledNodeRuntime({ resourcesRoot })
})().catch((err) => {
  console.error("[prebuild] failed:", err)
  process.exit(1)
})
