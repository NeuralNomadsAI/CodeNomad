#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "fs"
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

console.log(`[copy-ui-dist] Copied UI bundle from ${uiDistDir} -> ${targetDir}`)
