#!/usr/bin/env node
import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const cliRoot = path.resolve(__dirname, "..")
const distDir = path.join(cliRoot, "dist")
const publicDir = path.join(cliRoot, "public")
const authPagesSourceDir = path.join(distDir, "server", "routes", "auth-pages")
const authPagesTargetDir = path.join(distDir, "auth-pages")
const explicitTarget = process.env.CODENOMAD_STANDALONE_TARGET?.trim()
const outputName = (explicitTarget?.includes("windows") || process.platform === "win32") ? "codenomad-server.exe" : "codenomad-server"
const outputPath = path.join(distDir, outputName)
const packageJsonPath = path.join(cliRoot, "package.json")

function fail(message) {
  console.error(`[build-standalone] ${message}`)
  process.exit(1)
}

function ensureArtifacts() {
  const requiredPaths = [distDir, publicDir, authPagesSourceDir, packageJsonPath]
  const missing = requiredPaths.filter((filePath) => !fs.existsSync(filePath))
  if (missing.length > 0) {
    fail(`Missing required build artifacts: ${missing.join(", ")}. Run npm run build first.`)
  }

  const bunResult = spawnSync("bun", ["-v"], { cwd: cliRoot, encoding: "utf-8" })
  if (bunResult.status !== 0) {
    fail("Bun is required to build the standalone server executable.")
  }
}

function syncStandaloneAuthPages() {
  fs.rmSync(authPagesTargetDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(authPagesTargetDir), { recursive: true })
  fs.cpSync(authPagesSourceDir, authPagesTargetDir, { recursive: true })
}

function buildStandaloneExecutable() {
  fs.rmSync(outputPath, { force: true })

  const args = ["build", "--compile"]
  if (explicitTarget) {
    args.push(`--target=${explicitTarget}`)
  }
  args.push(path.join(cliRoot, "src", "index.ts"), "--outfile", outputPath)

  const result = spawnSync("bun", args, {
    cwd: cliRoot,
    stdio: "inherit",
  })

  if (result.status !== 0) {
    if (result.error) {
      throw result.error
    }
    throw new Error(`bun build --compile exited with code ${result.status ?? 1}`)
  }
}

function main() {
  ensureArtifacts()
  syncStandaloneAuthPages()

  buildStandaloneExecutable()
  console.log(`[build-standalone] built ${outputPath}`)
}

try {
  main()
} catch (error) {
  console.error("[build-standalone] failed:", error)
  process.exit(1)
}
