// Both desktop hosts bundle this exact npm, pinned in .npm-version separately
// from the Node archive and verified against the registry's sha512 integrity.
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const zlib = require("zlib")

const NPM_REGISTRY = "https://registry.npmjs.org"

function readExactVersion(file) {
  const value = fs.readFileSync(path.join(__dirname, "..", file), "utf8").trim()
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${file} must pin an exact release`)
  return value
}

const NPM_VERSION = readExactVersion(".npm-version")

function npmTarballUrl(version) {
  return `${NPM_REGISTRY}/npm/-/npm-${version}.tgz`
}

/** Fails unless one sha512 entry of the SRI string matches; weaker algorithms are ignored. */
function verifyIntegrity(buffer, integrity) {
  const expected = String(integrity ?? "").split(/\s+/).filter(entry => entry.startsWith("sha512-")).map(entry => entry.slice(7))
  if (!expected.length) throw new Error("npm registry metadata has no sha512 integrity")
  const actual = crypto.createHash("sha512").update(buffer).digest("base64")
  if (!expected.includes(actual)) throw new Error("Integrity mismatch for the npm package")
}

function tarString(block, start, length) {
  const end = block.indexOf(0, start)
  return block.toString("utf8", start, end === -1 || end > start + length ? start + length : end)
}

function paxPath(data) {
  let offset = 0
  let result
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    const length = Number(data.toString("utf8", offset, space))
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) throw new Error("Invalid npm package header")
    const record = data.toString("utf8", space + 1, offset + length - 1)
    if (record.startsWith("path=")) result = record.slice(5)
    offset += length
  }
  return result
}

/** Extracts an npm registry tarball's `package/` files and directories, refusing links and escapes. */
function extractNpmTarball(tarball, destination) {
  const archive = zlib.gunzipSync(tarball)
  let offset = 0
  let longName
  let files = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const size = parseInt(tarString(header, 124, 12).trim() || "0", 8)
    const type = String.fromCharCode(header[156] || 0x30)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid npm package entry size")
    const data = archive.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === "x") { longName = paxPath(data); continue }
    if (type === "L") { longName = tarString(data, 0, data.length); continue }
    if (type === "g") continue
    const prefix = tarString(header, 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100))
    longName = undefined
    const relative = path.posix.normalize(name.replace(/^package\//, ""))
    if (!name.startsWith("package/") || relative.startsWith("..") || path.posix.isAbsolute(relative) || /[\\:]/.test(relative)) {
      throw new Error(`Unexpected npm package path: ${name}`)
    }
    const target = path.join(destination, ...relative.split("/"))
    if (type === "5") { fs.mkdirSync(target, { recursive: true }); continue }
    if (type !== "0" && type !== "7") throw new Error(`Unsupported npm package entry type ${type}: ${name}`)
    const mode = parseInt(tarString(header, 100, 8).trim() || "644", 8)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data, { mode: mode & 0o111 ? 0o755 : 0o644 })
    files++
  }
  if (!files) throw new Error("The npm package is empty")
}

function readPackage(npmRoot) {
  return JSON.parse(fs.readFileSync(path.join(npmRoot, "package.json"), "utf8"))
}

/** npm itself only warns about an unsupported engine; packaging must refuse it. */
function checkNpmEngine(npmRoot, nodeVersion, runtimeLabel) {
  const engine = readPackage(npmRoot).engines?.node
  const semver = require(path.join(npmRoot, "node_modules", "semver"))
  if (!engine || !semver.satisfies(nodeVersion, engine)) {
    throw new Error(`npm ${readPackage(npmRoot).version} requires Node ${engine ?? "(undeclared)"}, but ${runtimeLabel} runs Node ${nodeVersion}`)
  }
  return engine
}

/** Downloads the pinned npm into `destination` (an empty directory) after verifying it. */
async function downloadPinnedNpm(request, destination, version = NPM_VERSION) {
  const manifest = JSON.parse((await request(`${NPM_REGISTRY}/npm/${version}`)).toString("utf8"))
  if (manifest.name !== "npm" || manifest.version !== version || manifest.dist?.tarball !== npmTarballUrl(version)) {
    throw new Error(`Unexpected registry metadata for npm ${version}`)
  }
  const tarball = await request(manifest.dist.tarball)
  verifyIntegrity(tarball, manifest.dist.integrity)
  extractNpmTarball(tarball, destination)
  const extracted = readPackage(destination)
  if (extracted.name !== "npm" || extracted.version !== version || !fs.existsSync(path.join(destination, "bin", "npm-cli.js"))) {
    throw new Error(`The npm ${version} package is incomplete`)
  }
  for (const dependency of extracted.bundleDependencies ?? []) {
    if (!fs.existsSync(path.join(destination, "node_modules", ...dependency.split("/"), "package.json"))) {
      throw new Error(`The npm ${version} package is missing its bundled dependency ${dependency}`)
    }
  }
  return destination
}

module.exports = { NPM_VERSION, checkNpmEngine, downloadPinnedNpm, extractNpmTarball, npmTarballUrl, readExactVersion, verifyIntegrity }
