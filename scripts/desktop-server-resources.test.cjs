const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { resolveNpmTarget, validateServerProductionLock } = require("./desktop-server-resources.cjs")
const { resolveEsbuildExecutable } = require("../packages/tauri-app/scripts/prebuild.js")

test("maps every supported desktop target to npm OS and CPU", () => {
  assert.deepEqual(resolveNpmTarget("darwin-x64"), { target: "darwin-x64", os: "darwin", cpu: "x64" })
  assert.deepEqual(resolveNpmTarget("darwin-arm64"), { target: "darwin-arm64", os: "darwin", cpu: "arm64" })
  assert.deepEqual(resolveNpmTarget("linux-x64"), { target: "linux-x64", os: "linux", cpu: "x64" })
  assert.deepEqual(resolveNpmTarget("linux-arm64"), { target: "linux-arm64", os: "linux", cpu: "arm64" })
  assert.deepEqual(resolveNpmTarget("win32-x64"), { target: "win32-x64", os: "win32", cpu: "x64" })
  assert.deepEqual(resolveNpmTarget("win32-arm64"), { target: "win32-arm64", os: "win32", cpu: "arm64" })
  assert.throws(() => resolveNpmTarget("freebsd-x64"), /Unsupported desktop packaging target/)
})

test("integrity-pins the full server production closure in the root lock", () => {
  const root = path.resolve(__dirname, "..")
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
  const closure = validateServerProductionLock(lock)

  assert.ok(closure.size > 100)
  assert.equal(lock.packages["node_modules/fastify"].version, "4.29.1")
  assert.equal(lock.packages["node_modules/undici"].version, "6.22.0")
  assert.equal(lock.packages["packages/server/node_modules/commander"].version, "12.1.0")
  assert.equal(lock.packages["packages/server/node_modules/fuzzysort"].version, "2.0.4")
})

test("resolves a macOS ARM64 esbuild binary nested under esbuild", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-esbuild-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const esbuildRoot = path.join(root, "node_modules", "esbuild")
  const platformRoot = path.join(esbuildRoot, "node_modules", "@esbuild", "darwin-arm64")
  fs.mkdirSync(path.join(platformRoot, "bin"), { recursive: true })
  fs.writeFileSync(path.join(esbuildRoot, "package.json"), JSON.stringify({ name: "esbuild", version: "0.25.12" }))
  fs.writeFileSync(path.join(platformRoot, "package.json"), JSON.stringify({
    name: "@esbuild/darwin-arm64",
    version: "0.25.12",
    os: ["darwin"],
    cpu: ["arm64"],
  }))
  fs.writeFileSync(path.join(platformRoot, "bin", "esbuild"), "")

  assert.equal(fs.existsSync(path.join(root, "node_modules", "@esbuild", "darwin-arm64")), false)
  assert.deepEqual(resolveEsbuildExecutable(root, "darwin", "arm64"), {
    executable: path.join(platformRoot, "bin", "esbuild"),
    version: "0.25.12",
  })
})
