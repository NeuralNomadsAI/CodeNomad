#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")
const { pathToFileURL } = require("url")

const root = path.resolve(__dirname, "..")
const workspaceRoot = path.resolve(root, "..", "..")
const uiRoot = path.resolve(root, "..", "ui")
const uiDist = path.resolve(uiRoot, "src", "renderer", "dist")
const uiLoadingDest = path.resolve(root, "src-tauri", "resources", "ui-loading")

async function ensureMonacoAssets() {
  const helperPath = path.join(uiRoot, "scripts", "monaco-public-assets.js")
  const helperUrl = pathToFileURL(helperPath).href
  const { copyMonacoPublicAssets } = await import(helperUrl)
  copyMonacoPublicAssets({
    uiRendererRoot: path.join(uiRoot, "src", "renderer"),
    warn: (msg) => console.warn(`[dev-prep] ${msg}`),
    sourceRoots: [
      path.resolve(workspaceRoot, "node_modules", "monaco-editor", "min", "vs"),
      path.resolve(uiRoot, "node_modules", "monaco-editor", "min", "vs"),
    ],
  })
}

function ensureUiBuild() {
  const loadingHtml = path.join(uiDist, "loading.html")
  if (fs.existsSync(loadingHtml)) {
    return
  }

  console.log("[dev-prep] UI loader build missing; running workspace build…")
  execSync("npm --workspace @codenomad/ui run build", {
    cwd: workspaceRoot,
    stdio: "inherit",
  })

  if (!fs.existsSync(loadingHtml)) {
    throw new Error("[dev-prep] failed to produce loading.html after UI build")
  }
}

function copyUiLoadingAssets() {
  const loadingSource = path.join(uiDist, "loading.html")
  const assetsSource = path.join(uiDist, "assets")

  fs.rmSync(uiLoadingDest, { recursive: true, force: true })
  fs.mkdirSync(uiLoadingDest, { recursive: true })

  fs.copyFileSync(loadingSource, path.join(uiLoadingDest, "loading.html"))
  if (fs.existsSync(assetsSource)) {
    fs.cpSync(assetsSource, path.join(uiLoadingDest, "assets"), { recursive: true })
  }

  console.log(`[dev-prep] copied loader bundle from ${uiDist}`)
}

;(async () => {
  await ensureMonacoAssets()
  ensureUiBuild()
  copyUiLoadingAssets()
})().catch((err) => {
  console.error("[dev-prep] failed:", err)
  process.exit(1)
})
