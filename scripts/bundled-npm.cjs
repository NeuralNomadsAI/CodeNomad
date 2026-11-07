// Both desktop hosts bundle this exact npm, pinned in .npm-version separately
// from the Node archive. The registry tarball is accepted only when its sha512
// matches the integrity the same registry publishes for that version: this
// proves the bytes are the registry's published package (and HTTPS protects the
// transfer), not an independent publisher signature.
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

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

/** The system tar refuses absolute and `..` member paths; this also refuses any
 * link, device or other root than npm's `package/` that it may have written. */
function extractedPackage(extractRoot) {
  const roots = fs.readdirSync(extractRoot)
  if (roots.length !== 1 || roots[0] !== "package") throw new Error(`Unexpected npm package contents: ${roots.join(", ")}`)
  const pending = [path.join(extractRoot, "package")]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(file)
      else if (!entry.isFile()) throw new Error(`Unsupported npm package entry: ${path.relative(extractRoot, file)}`)
    }
  }
  return path.join(extractRoot, "package")
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

/** Downloads, verifies and extracts the pinned npm under `workRoot` (an empty
 * directory) with `extract(archive, destination)`; returns the package root. */
async function downloadPinnedNpm({ request, extract, workRoot, version = NPM_VERSION }) {
  const manifest = JSON.parse((await request(`${NPM_REGISTRY}/npm/${version}`)).toString("utf8"))
  if (manifest.name !== "npm" || manifest.version !== version || manifest.dist?.tarball !== npmTarballUrl(version)) {
    throw new Error(`Unexpected registry metadata for npm ${version}`)
  }
  const tarball = await request(manifest.dist.tarball)
  verifyIntegrity(tarball, manifest.dist.integrity)
  const archive = path.join(workRoot, `npm-${version}.tgz`)
  const extractRoot = path.join(workRoot, "npm-package")
  fs.writeFileSync(archive, tarball)
  fs.mkdirSync(extractRoot)
  extract(archive, extractRoot)
  const npmRoot = extractedPackage(extractRoot)
  const extracted = readPackage(npmRoot)
  if (extracted.name !== "npm" || extracted.version !== version || !fs.existsSync(path.join(npmRoot, "bin", "npm-cli.js"))) {
    throw new Error(`The npm ${version} package is incomplete`)
  }
  for (const dependency of extracted.bundleDependencies ?? []) {
    if (!fs.existsSync(path.join(npmRoot, "node_modules", ...dependency.split("/"), "package.json"))) {
      throw new Error(`The npm ${version} package is missing its bundled dependency ${dependency}`)
    }
  }
  return npmRoot
}

module.exports = { NPM_VERSION, checkNpmEngine, downloadPinnedNpm, extractedPackage, npmTarballUrl, readExactVersion, verifyIntegrity }
