const fs = require("fs")
const https = require("https")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

const MANAGED_NODE_VERSION = "v22.22.2"

const ARTIFACTS = {
  "darwin-x64": { archive: `node-${MANAGED_NODE_VERSION}-darwin-x64.tar.gz`, root: `node-${MANAGED_NODE_VERSION}-darwin-x64`, binary: path.join("bin", "node") },
  "darwin-arm64": { archive: `node-${MANAGED_NODE_VERSION}-darwin-arm64.tar.gz`, root: `node-${MANAGED_NODE_VERSION}-darwin-arm64`, binary: path.join("bin", "node") },
  "linux-x64": { archive: `node-${MANAGED_NODE_VERSION}-linux-x64.tar.gz`, root: `node-${MANAGED_NODE_VERSION}-linux-x64`, binary: path.join("bin", "node") },
  "linux-arm64": { archive: `node-${MANAGED_NODE_VERSION}-linux-arm64.tar.gz`, root: `node-${MANAGED_NODE_VERSION}-linux-arm64`, binary: path.join("bin", "node") },
  "win32-x64": { archive: `node-${MANAGED_NODE_VERSION}-win-x64.zip`, root: `node-${MANAGED_NODE_VERSION}-win-x64`, binary: "node.exe" },
  "win32-arm64": { archive: `node-${MANAGED_NODE_VERSION}-win-arm64.zip`, root: `node-${MANAGED_NODE_VERSION}-win-arm64`, binary: "node.exe" },
}

function normalizeTarget(platform, arch) {
  const normalizedPlatform = platform === "mac" || platform === "macos" ? "darwin" : platform === "win" || platform === "windows" ? "win32" : platform
  const normalizedArch = arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch
  return `${normalizedPlatform}-${normalizedArch}`
}

function currentTarget() {
  return normalizeTarget(process.platform, process.arch)
}

function targetFromTriple(triple) {
  if (!triple) return null
  const value = String(triple).toLowerCase()
  const arch = value.startsWith("x86_64") ? "x64" : value.startsWith("aarch64") ? "arm64" : null
  if (!arch) return null
  if (value.includes("apple-darwin")) return `darwin-${arch}`
  if (value.includes("pc-windows") || value.includes("windows-msvc") || value.includes("windows-gnu")) return `win32-${arch}`
  if (value.includes("unknown-linux") || value.includes("linux-gnu") || value.includes("linux-musl")) return `linux-${arch}`
  return null
}

function resolveTarget(explicitTarget) {
  return (
    explicitTarget ||
    process.env.CODENOMAD_NODE_TARGET ||
    targetFromTriple(process.env.TAURI_ENV_TARGET_TRIPLE) ||
    targetFromTriple(process.env.TAURI_TARGET_TRIPLE) ||
    targetFromTriple(process.env.CARGO_BUILD_TARGET) ||
    targetFromTriple(process.env.TARGET) ||
    targetFromTriple(process.env.npm_config_target) ||
    currentTarget()
  )
}

function request(url) {
  return new Promise((resolve, reject) => {
    const run = (target) => {
      https
        .get(target, (response) => {
          const status = response.statusCode || 0
          const redirect = response.headers.location
          if (status >= 300 && status < 400 && redirect) {
            response.resume()
            run(new URL(redirect, target).toString())
            return
          }
          if (status < 200 || status >= 300) {
            response.resume()
            reject(new Error(`Request failed for ${target} with status ${status}`))
            return
          }
          const chunks = []
          response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
          response.on("end", () => resolve(Buffer.concat(chunks)))
          response.on("error", reject)
        })
        .on("error", reject)
    }
    run(url)
  })
}

async function downloadFile(url, destination) {
  const body = await request(url)
  fs.writeFileSync(destination, body)
}

async function fetchExpectedSha(archiveName) {
  const checksums = (await request(`https://nodejs.org/dist/${MANAGED_NODE_VERSION}/SHASUMS256.txt`)).toString("utf8")
  for (const line of checksums.split(/\r?\n/)) {
    const [checksum, filename] = line.trim().split(/\s+/, 2)
    if (filename === archiveName) return checksum
  }
  throw new Error(`Unable to find checksum for ${archiveName}`)
}

function sha256File(filePath) {
  const crypto = require("crypto")
  const hash = crypto.createHash("sha256")
  hash.update(fs.readFileSync(filePath))
  return hash.digest("hex")
}

function find7zip() {
  try {
    return require("7zip-bin").path7za
  } catch {
    return process.platform === "win32" ? "7z.exe" : "7z"
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.status !== 0) {
    if (result.error) throw result.error
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status || 1}`)
  }
}

function extractArchive(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true })
  if (archivePath.endsWith(".zip")) {
    const sevenZip = find7zip()
    if (fs.existsSync(sevenZip)) {
      fs.chmodSync(sevenZip, 0o755)
    }
    run(sevenZip, ["x", archivePath, `-o${destination}`, "-y"])
    return
  }
  run("tar", ["-xzf", archivePath, "-C", destination])
}

function pruneForRuntime(sourceRoot, destinationRoot) {
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true, dereference: true })
  for (const name of ["CHANGELOG.md", "LICENSE", "README.md", "corepack", "npm", "npx"]) {
    fs.rmSync(path.join(destinationRoot, "bin", name), { recursive: true, force: true })
  }
  fs.rmSync(path.join(destinationRoot, "lib", "node_modules", "npm"), { recursive: true, force: true })
  fs.rmSync(path.join(destinationRoot, "lib", "node_modules", "corepack"), { recursive: true, force: true })
  fs.rmSync(path.join(destinationRoot, "node_modules", "npm"), { recursive: true, force: true })
  fs.rmSync(path.join(destinationRoot, "node_modules", "corepack"), { recursive: true, force: true })
}

async function prepareBundledNodeRuntime(options) {
  const target = resolveTarget(options && options.target)
  const spec = ARTIFACTS[target]
  if (!spec) {
    throw new Error(`Bundled Node runtime is not supported for target ${target}`)
  }

  const resourcesRoot = options.resourcesRoot
  if (!resourcesRoot) {
    throw new Error("resourcesRoot is required")
  }

  const nodeRoot = path.join(resourcesRoot, "node")
  const runtimeRoot = path.join(nodeRoot, target)
  const runtimeBinary = path.join(runtimeRoot, spec.binary)
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `codenomad-node-${target}-`))
  const archivePath = path.join(tempRoot, spec.archive)
  const extractRoot = path.join(tempRoot, "extract")

  try {
    fs.rmSync(nodeRoot, { recursive: true, force: true })
    fs.mkdirSync(nodeRoot, { recursive: true })

    console.log(`[node-runtime] downloading ${spec.archive}`)
    const expectedSha = await fetchExpectedSha(spec.archive)
    await downloadFile(`https://nodejs.org/dist/${MANAGED_NODE_VERSION}/${spec.archive}`, archivePath)
    const actualSha = sha256File(archivePath)
    if (actualSha !== expectedSha) {
      throw new Error(`Checksum mismatch for ${spec.archive}`)
    }

    extractArchive(archivePath, extractRoot)
    const extractedRoot = path.join(extractRoot, spec.root)
    if (!fs.existsSync(path.join(extractedRoot, spec.binary))) {
      throw new Error(`Node binary missing after extraction: ${path.join(extractedRoot, spec.binary)}`)
    }

    pruneForRuntime(extractedRoot, runtimeRoot)
    if (!target.startsWith("win32-")) {
      fs.chmodSync(runtimeBinary, 0o755)
    }

    if (target === currentTarget()) {
      run(runtimeBinary, ["--version"])
    } else {
      console.log(`[node-runtime] skipped ${target} execution check on ${currentTarget()} build host`)
    }
    console.log(`[node-runtime] prepared ${target} at ${runtimeRoot}`)
    return { target, runtimeRoot, runtimeBinary }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

module.exports = {
  MANAGED_NODE_VERSION,
  prepareBundledNodeRuntime,
  normalizeTarget,
  currentTarget,
}
