// Keys, paths and integrity checks of the CI download caches
// (.github/actions/download-cache, .github/workflows/download-cache.yml).
"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

const root = path.resolve(__dirname, "../..")
// Assets of releases that change in place ("continuous"): keyed and checked by
// the SHA-256 digest GitHub publishes for them.
const RUNTIME = { repo: "AppImage/type2-runtime", asset: "runtime-x86_64" }
const RUNTIME_URL = `https://github.com/${RUNTIME.repo}/releases/download/continuous/${RUNTIME.asset}`
// tauri-bundler stores this plugin as linuxdeploy-plugin-appimage.AppImage.
const APPIMAGE_PLUGIN = { repo: "linuxdeploy/linuxdeploy-plugin-appimage", asset: "linuxdeploy-plugin-appimage-x86_64.AppImage" }
const APPIMAGE_PLUGIN_FILE = "linuxdeploy-plugin-appimage.AppImage"

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

function lockedVersion(lock, name) {
  const version = lock.packages?.[`node_modules/${name}`]?.version
  if (!version) throw new Error(`package-lock.json does not lock ${name} at the root`)
  return version
}

function appBuilderVersion(lock) {
  let selected
  for (const owner of ["packages/electron-app/node_modules/app-builder-bin", "node_modules/app-builder-bin"]) {
    if (!Object.hasOwn(lock.packages ?? {}, owner)) continue
    const entry = lock.packages[owner]
    let url
    try { if (typeof entry?.resolved === "string") url = new URL(entry.resolved) } catch {}
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.version !== "string" || entry.version !== entry.version.trim()
      || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(entry.version)
      || !url || !entry.resolved.startsWith("https://") || /\s/.test(entry.resolved)
      || url.protocol !== "https:" || !url.hostname || url.username || url.password
      || typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)
      || Buffer.from(entry.integrity.slice(7), "base64").toString("base64") !== entry.integrity.slice(7)) {
      throw new Error(`package-lock.json has an invalid app-builder-bin identity at ${owner}`)
    }
    if (selected && ["version", "resolved", "integrity"].some((field) => selected[field] !== entry[field])) {
      throw new Error("package-lock.json has conflicting app-builder-bin identities")
    }
    selected = entry
  }
  if (!selected) throw new Error("package-lock.json does not lock app-builder-bin for packages/electron-app")
  return selected.version
}

// Defaults shared by @electron/get (env-paths), app-builder (GetCacheDirectory)
// and tauri-bundler (dirs::cache_dir).
function cacheHome({ env, platform, home }) {
  if (platform === "darwin") return path.join(home, "Library", "Caches")
  if (platform === "win32") return env.LOCALAPPDATA || path.join(home, "AppData", "Local")
  return env.XDG_CACHE_HOME || path.join(home, ".cache")
}

const electronDir = (host) => path.join(cacheHome(host), "electron", host.platform === "win32" ? "Cache" : "")
// build-and-upload packages both macOS architectures on the Intel runner.
const electronTargets = ({ platform, arch }) =>
  platform === "darwin" && arch === "x64" ? ["darwin-x64", "darwin-arm64"] : [`${platform}-${arch}`]

function cargoLock(text) {
  const crates = new Map()
  for (const block of text.replace(/\r\n/g, "\n").split("[[package]]").slice(1)) {
    const field = (name) => block.match(new RegExp(`^${name} = "([^"]+)"$`, "m"))?.[1]
    if (field("source")?.startsWith("registry+") && field("checksum")) {
      crates.set(`${field("name")}-${field("version")}.crate`, field("checksum"))
    }
  }
  return crates
}

function spec(kind, host, inputs) {
  const { env, platform, arch, home } = host
  const id = `${platform}-${arch}`
  if (kind === "electron") {
    // A relocated cache would not match the paths seeded here.
    if (env.electron_config_cache || env.ELECTRON_CACHE || env.ELECTRON_BUILDER_CACHE) return null
    const lock = JSON.parse(inputs.packageLock)
    const paths = [electronDir(host)]
    // electron-builder's own downloads: fpm (deb) and winCodeSign (rcedit).
    if (platform !== "darwin") paths.push(path.join(cacheHome(host), "electron-builder", platform === "win32" ? "Cache" : ""))
    const key = `electron-${id}-${lockedVersion(lock, "electron")}-app-builder-bin-${appBuilderVersion(lock)}`
    return { key, paths }
  }
  if (kind === "cargo") {
    const cargoHome = path.join(home, ".cargo")
    if (env.CARGO_HOME && path.resolve(env.CARGO_HOME) !== cargoHome) return null
    const text = inputs.cargoLock.replace(/\r\n/g, "\n")
    // Download caches only: registry/src and target/ are rebuilt by every job.
    const paths = [path.join(cargoHome, "registry", "index"), path.join(cargoHome, "registry", "cache")]
    if (/^source = "git\+/m.test(text)) paths.push(path.join(cargoHome, "git", "db"))
    return { key: `cargo-${id}-${sha256(text)}`, paths, restoreKeys: `cargo-${id}-` }
  }
  if (kind === "tauri") {
    if (platform === "darwin") return null // the macOS app bundle downloads no tools
    const linux = platform === "linux"
    if (linux && !isDigest(inputs.pluginDigest)) return null
    const lock = JSON.parse(inputs.packageLock)
    const key = `tauri-${id}-${lockedVersion(lock, "@tauri-apps/cli")}${linux ? `-${inputs.pluginDigest}` : ""}`
    return { key, paths: [path.join(cacheHome(host), "tauri")] }
  }
  if (kind === "appimage-runtime") {
    if (platform !== "linux" || arch !== "x64" || !isDigest(inputs.runtimeDigest)) return null
    return {
      key: `appimage-runtime-x86_64-${inputs.runtimeDigest}`,
      paths: [path.join(cacheHome(host), "appimage-type2-runtime", RUNTIME.asset)],
    }
  }
  throw new Error(`Unknown download cache kind: ${kind}`)
}

const isDigest = (value) => /^[0-9a-f]{64}$/.test(value ?? "")

async function releaseDigest({ repo, asset }, env) {
  try {
    const headers = { accept: "application/vnd.github+json" }
    if (env.GH_TOKEN) headers.authorization = `Bearer ${env.GH_TOKEN}`
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/continuous`, { headers })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const digest = (await response.json()).assets?.find((entry) => entry.name === asset)?.digest
    return digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1]
  } catch (error) {
    // stderr: `spec` writes its stdout to $GITHUB_OUTPUT.
    console.error(`::notice::No digest for ${repo} ${asset} (${error.message}); its tool downloads it`)
  }
}

function outputs(result) {
  if (!result) return ""
  const lines = [`key=${result.key}`, "path<<__PATHS__", ...result.paths, "__PATHS__"]
  if (result.restoreKeys) lines.push(`restore-keys=${result.restoreKeys}`)
  return `${lines.join("\n")}\n`
}

// Cargo does not re-check a .crate it finds in registry/cache against Cargo.lock;
// a crate that does not match is removed so Cargo downloads and verifies it.
function verifyCrates(cacheDir, crates) {
  let removed = 0
  const registries = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { withFileTypes: true }) : []
  for (const registry of registries.filter((entry) => entry.isDirectory())) {
    const dir = path.join(cacheDir, registry.name)
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      if (crates.get(name) === sha256(fs.readFileSync(file))) continue
      fs.rmSync(file, { force: true })
      removed++
    }
  }
  return removed
}

function verifiedFile(file, expected) {
  if (!fs.existsSync(file)) return false
  if (sha256(fs.readFileSync(file)) === expected) return true
  fs.rmSync(file, { force: true })
  console.log(`::warning::Removed ${file}: its SHA-256 does not match`)
  return false
}

// app-builder neither looks in @electron/get's cache nor checks Electron zips:
// give it each zip @electron/get stores, after checking it against electron/checksums.json.
function linkElectronZips(host, version, checksums) {
  const dir = electronDir(host)
  for (const target of electronTargets(host)) {
    const name = `electron-v${version}-${target}.zip`
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []
    const source = entries.filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name, name))
      .find((file) => verifiedFile(file, checksums[name]))
    if (!source) continue
    const destination = path.join(dir, name)
    fs.rmSync(destination, { force: true })
    try { fs.linkSync(source, destination) } catch { fs.copyFileSync(source, destination) }
    console.log(`Verified ${name} for electron-builder`)
  }
}

async function main([command, kind]) {
  const host = { env: process.env, platform: process.platform, arch: process.arch, home: os.homedir() }
  const inputs = () => ({
    packageLock: read("package-lock.json"),
    cargoLock: read("packages/tauri-app/Cargo.lock"),
  })
  if (command === "spec") {
    const linuxX64 = host.platform === "linux" && host.arch === "x64"
    const extra = {}
    if (linuxX64 && kind === "appimage-runtime") extra.runtimeDigest = await releaseDigest(RUNTIME, process.env)
    if (linuxX64 && kind === "tauri") extra.pluginDigest = await releaseDigest(APPIMAGE_PLUGIN, process.env)
    process.stdout.write(outputs(spec(kind, host, { ...inputs(), ...extra })))
  } else if (command === "verify" && kind === "cargo") {
    const removed = verifyCrates(path.join(host.home, ".cargo", "registry", "cache"), cargoLock(inputs().cargoLock))
    if (removed) console.log(`::warning::Removed ${removed} cached crates that Cargo.lock does not verify`)
  } else if (command === "verify" && kind === "tauri") {
    // tauri-bundler never refreshes a stored plugin: a stale or altered one is removed.
    const digest = process.env.CACHE_KEY.split("-").pop()
    if (host.platform === "linux") verifiedFile(path.join(process.env.CACHE_PATH, APPIMAGE_PLUGIN_FILE), digest)
  } else if (command === "verify" && kind === "appimage-runtime") {
    const file = process.env.CACHE_PATH
    if (verifiedFile(file, process.env.CACHE_KEY.split("-").pop())) {
      fs.appendFileSync(process.env.GITHUB_ENV, `LDAI_RUNTIME_FILE=${file}\n`)
    }
  } else if (command === "link" && kind === "electron") {
    const electron = path.dirname(require.resolve("electron/package.json", { paths: [root] }))
    linkElectronZips(host, require(path.join(electron, "package.json")).version, require(path.join(electron, "checksums.json")))
  } else if (command === "seed" && kind === "electron") {
    const electron = path.dirname(require.resolve("electron/package.json", { paths: [root] }))
    const { downloadArtifact } = await import(pathToFileURL(require.resolve("@electron/get", { paths: [root] })))
    const { version } = require(path.join(electron, "package.json"))
    for (const target of electronTargets(host)) {
      const [platform, arch] = target.split("-")
      // As electron's install script: checked against the checksums the package ships.
      await downloadArtifact({ version, artifactName: "electron", platform, arch, checksums: require(path.join(electron, "checksums.json")) })
    }
    // The archives electron-builder fetches itself, each checked against app-builder's SHA-512.
    const { getBin } = require(require.resolve("app-builder-lib/out/binDownload", { paths: [root] }))
    if (host.platform === "linux") await getBin("fpm")
    if (host.platform === "win32") await getBin("winCodeSign")
  } else if (command === "seed" && kind === "appimage-runtime") {
    const response = await fetch(RUNTIME_URL)
    const data = Buffer.from(await response.arrayBuffer())
    if (!response.ok || sha256(data) !== process.env.CACHE_KEY.split("-").pop()) {
      console.log(`::warning::AppImage runtime not seeded (HTTP ${response.status} or digest mismatch)`)
      return
    }
    fs.mkdirSync(path.dirname(process.env.CACHE_PATH), { recursive: true })
    fs.writeFileSync(process.env.CACHE_PATH, data, { mode: 0o755 })
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "ready=true\n")
  } else {
    throw new Error(`Usage: download-cache.cjs spec|verify|link|seed <kind>`)
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

module.exports = { cargoLock, electronTargets, linkElectronZips, outputs, spec, verifyCrates }
