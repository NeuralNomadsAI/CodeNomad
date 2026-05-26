#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const cliRoot = path.resolve(__dirname, "..")
const uiDistDir = path.resolve(cliRoot, "../ui/src/renderer/dist")
const targetDir = path.resolve(cliRoot, "public")

if (!existsSync(uiDistDir)) {
  console.error(`[copy-ui-dist] Expected UI build artifacts at ${uiDistDir}. Run the UI build before bundling the CLI.`)
  process.exit(1)
}

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })
cpSync(uiDistDir, targetDir, { recursive: true })

// Patch index.html to unregister any existing service worker
const htmlPath = path.join(targetDir, "index.html")
if (existsSync(htmlPath)) {
  let html = readFileSync(htmlPath, "utf-8")
  const script = '<script>if("serviceWorker" in navigator){navigator.serviceWorker.getRegistrations().then(r=>r.forEach(r=>r.unregister()))}</script>'
  if (!html.includes(script)) {
    html = html.replace("</head>", script + "</head>")
    writeFileSync(htmlPath, html, "utf-8")
    console.log("[copy-ui-dist] Injected SW unregister script")
  }
}

console.log(`[copy-ui-dist] Copied UI bundle from ${uiDistDir} -> ${targetDir}`)
