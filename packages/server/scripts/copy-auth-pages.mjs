#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const cliRoot = path.resolve(__dirname, "..")

const sourceDir = path.resolve(cliRoot, "src/server/routes/auth-pages")
const targetDir = path.resolve(cliRoot, "dist/server/routes/auth-pages")

if (!existsSync(sourceDir)) {
  console.error(`[copy-auth-pages] Missing auth pages at ${sourceDir}`)
  process.exit(1)
}

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })
cpSync(sourceDir, targetDir, { recursive: true })

console.log(`[copy-auth-pages] Copied ${sourceDir} -> ${targetDir}`)
