#!/usr/bin/env node
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")
const { MANAGED_NODE_VERSION } = require("./prepare-node-runtime.cjs")

const requiredPackages = [
  "yaml",
  "fastify",
  "@fastify/static",
  "@fastify/cors",
  "@fastify/reply-from",
  "@opencode/client",
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
    else if (arg === "--target") options.target = argv[++index]
    else if (arg === "--electron") options.electron = argv[++index] || require("electron")
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

function targetParts(target) {
  const [platform, ...archParts] = target.split("-")
  const arch = archParts.join("-")
  if (!platform || !arch) throw new Error(`Invalid target: ${target}`)
  return { platform, arch }
}

function nodeBinary(resourcesRoot, target) {
  const { platform } = targetParts(target)
  const executable = platform === "win32" ? "node.exe" : path.join("bin", "node")
  return path.join(resourcesRoot, "node", target, executable)
}

function canExecuteTarget(target) {
  return target === platformDirName()
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? 1}`)
  }
  return result
}

function smokeServer(resourcesRoot, target, electron) {
  const serverRoot = path.join(resourcesRoot, "server")
  const entrypoint = path.join(serverRoot, "dist", "bin.js")
  // Remote Control's self-contained OpenTunnel bundle, loaded on demand.
  const remoteTunnel = path.join(serverRoot, "dist", "remote-control", "tunnel-runtime.js")
  // The web app's icon, which also names Tauri's notifications on Windows.
  const appIcon = path.join(serverRoot, "public", "pwa-192x192.png")
  const node = electron ? path.resolve(electron) : nodeBinary(resourcesRoot, target)
  const npm = electron ? path.join(resourcesRoot, "node", target, "npm", "bin", "npm-cli.js")
    : path.join(resourcesRoot, "node", target, target.startsWith("win32-") ? "node_modules" : "lib/node_modules", "npm", "bin", "npm-cli.js")

  for (const requiredPath of [npm, node, entrypoint, remoteTunnel, appIcon, path.join(serverRoot, "node_modules")]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Missing packaged runtime path: ${requiredPath}`)
  }

  for (const packageName of requiredPackages) {
    const packageRoot = path.join(serverRoot, "node_modules", ...packageName.split("/"))
    if (!fs.existsSync(packageRoot)) throw new Error(`Missing packaged dependency: ${packageName}`)
  }

  console.log(`packaged server static checks ok for ${target}`)
  if (electron && fs.existsSync(nodeBinary(resourcesRoot, target))) throw new Error("Electron resources contain a redundant Node executable")

  if (!canExecuteTarget(target)) {
    console.log(`skipping executable smoke for ${target} on host ${platformDirName()}`)
    return
  }

  const env = electron ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env
  const version = run(node, ["--version"], { stdio: "pipe", encoding: "utf8", env }).stdout.trim()
  if (!electron && version !== MANAGED_NODE_VERSION) {
    throw new Error(`Packaged Node version ${version} does not match ${MANAGED_NODE_VERSION}`)
  }
  console.log(`packaged Node version ok: ${version}`)
  // npm only warns about an unsupported engine; Electron's Node must satisfy it.
  const npmRoot = path.dirname(path.dirname(npm))
  const engine = JSON.parse(fs.readFileSync(path.join(npmRoot, "package.json"), "utf8")).engines?.node
  const semver = require(path.join(npmRoot, "node_modules", "semver"))
  if (!engine || !semver.satisfies(version, engine)) {
    throw new Error(`Bundled npm requires Node ${engine ?? "(undeclared)"}, but the server runtime reports ${version}`)
  }
  console.log(`bundled npm engine ok: ${version} satisfies ${engine}`)
  run(node, [npm, "--version"], { env })
  run(node, [entrypoint, "--version"], { env })

  const importScript = [
    `for (const name of ${JSON.stringify(requiredPackages)}) await import(name);`,
    `const tunnel = await import(${JSON.stringify(require("url").pathToFileURL(remoteTunnel).href)});`,
    "if (typeof tunnel.openRemoteTunnel !== 'function') throw new Error('Remote Control tunnel runtime is incomplete');",
    "console.log('packaged dependency imports ok');",
  ].join(" ")

  // Resolve from the packaged server, not the build checkout. The V2 client is ESM-only.
  run(node, ["--input-type=module", "-e", importScript], { cwd: serverRoot, env })
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
  const target = options.target ?? platformDirName()
  smokeServer(resourcesRoot, target, options.electron)
  smokeLoadingAssets(options.loading ? path.resolve(options.loading) : null)
} catch (error) {
  console.error("[smoke-packaged-resources] failed:", error)
  process.exit(1)
}
