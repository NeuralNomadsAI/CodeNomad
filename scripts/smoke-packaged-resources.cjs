#!/usr/bin/env node
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const requiredPackages = [
  "yaml",
  "fastify",
  "@fastify/static",
  "@fastify/cors",
  "@fastify/reply-from",
  "openai",
  "pino",
  "undici",
  "zod",
  "node-forge",
]

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--resources") options.resources = argv[++index]
    else if (arg === "--loading") options.loading = argv[++index]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.resources) throw new Error("Missing --resources <path>")
  return options
}

function platformDirName() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch
  return `${platform}-${arch}`
}

function nodeBinary(resourcesRoot) {
  const executable = process.platform === "win32" ? "node.exe" : path.join("bin", "node")
  return path.join(resourcesRoot, "node", platformDirName(), executable)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? 1}`)
  }
}

function smokeServer(resourcesRoot) {
  const serverRoot = path.join(resourcesRoot, "server")
  const entrypoint = path.join(serverRoot, "dist", "bin.js")
  const node = nodeBinary(resourcesRoot)

  for (const requiredPath of [node, entrypoint, path.join(serverRoot, "node_modules")]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Missing packaged runtime path: ${requiredPath}`)
  }

  run(node, [entrypoint, "--version"])

  const requireScript = [
    "import { createRequire } from 'module';",
    "import path from 'path';",
    `const root = ${JSON.stringify(serverRoot)};`,
    "const req = createRequire(path.join(root, 'dist/bin.js'));",
    `${JSON.stringify(requiredPackages)}.forEach((name) => req(name));`,
    "console.log('packaged dependency imports ok');",
  ].join(" ")

  run(node, ["--input-type=module", "-e", requireScript])
}

function smokeLoadingAssets(loadingRoot) {
  if (!loadingRoot) return

  const htmlPath = path.join(loadingRoot, "loading.html")
  if (!fs.existsSync(htmlPath)) throw new Error(`Missing loading HTML: ${htmlPath}`)

  const html = fs.readFileSync(htmlPath, "utf8")
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1])
  for (const ref of refs) {
    if (/^(?:https?:)?\/\//.test(ref)) continue
    if (!ref.startsWith("/assets/") && !ref.startsWith("assets/")) continue

    const relative = ref.replace(/^\//, "")
    const target = path.join(loadingRoot, relative)
    if (!fs.existsSync(target)) throw new Error(`Missing loading asset referenced by ${htmlPath}: ${ref}`)
  }

  console.log("loading asset references ok")
}

try {
  const options = parseArgs(process.argv.slice(2))
  const resourcesRoot = path.resolve(options.resources)
  smokeServer(resourcesRoot)
  smokeLoadingAssets(options.loading ? path.resolve(options.loading) : null)
} catch (error) {
  console.error("[smoke-packaged-resources] failed:", error)
  process.exit(1)
}
