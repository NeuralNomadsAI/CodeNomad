const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { resolveNpmTarget, validateServerProductionLock } = require("./desktop-server-resources.cjs")
const { resolveEsbuildExecutable } = require("../packages/tauri-app/scripts/prebuild.js")
const { copyPackagedServerResources } = require("./desktop-server-resources.cjs")

test("maps every supported desktop target to npm OS and CPU", () => {
  assert.deepEqual(resolveNpmTarget("darwin-x64"), { target: "darwin-x64", os: "darwin", cpu: "x64" })
  assert.deepEqual(resolveNpmTarget("darwin-arm64"), { target: "darwin-arm64", os: "darwin", cpu: "arm64" })
  assert.deepEqual(resolveNpmTarget("linux-x64"), { target: "linux-x64", os: "linux", cpu: "x64" })
  assert.deepEqual(resolveNpmTarget("linux-arm64"), { target: "linux-arm64", os: "linux", cpu: "arm64" })
  assert.deepEqual(resolveNpmTarget("win32-x64"), { target: "win32-x64", os: "win32", cpu: "x64" })
  assert.deepEqual(resolveNpmTarget("win32-arm64"), { target: "win32-arm64", os: "win32", cpu: "arm64" })
  assert.throws(() => resolveNpmTarget("freebsd-x64"), /Unsupported desktop packaging target/)
})

test("glibc desktop resources omit musl-only msgpackr binaries and retain the native loader", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-glibc-resources-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const serverRoot = path.join(root, "source")
  for (const name of ["public", "dist", "node_modules"]) fs.mkdirSync(path.join(serverRoot, name), { recursive: true })
  fs.writeFileSync(path.join(serverRoot, "package.json"), "{}")
  for (const cpu of ["x64", "arm64"]) {
    const relative = path.join("node_modules", "@msgpackr-extract", `msgpackr-extract-linux-${cpu}`)
    fs.mkdirSync(path.join(serverRoot, relative), { recursive: true })
    for (const name of ["node.napi.glibc.node", "node.abi115.musl.node", "node.napi.musl.node", "index.js", "package.json"]) {
      fs.writeFileSync(path.join(serverRoot, relative, name), name)
    }
    const serverDest = path.join(root, cpu)
    copyPackagedServerResources({ serverRoot, serverDest, target: `linux-${cpu}` })
    assert.deepEqual(fs.readdirSync(path.join(serverDest, relative)).sort(), ["index.js", "node.napi.glibc.node", "package.json"])
    assert(fs.existsSync(path.join(serverRoot, relative, "node.napi.musl.node")), "source installation is untouched")
  }
})

test("integrity-pins the full server production closure in the root lock", () => {
  const root = path.resolve(__dirname, "..")
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
  const closure = validateServerProductionLock(lock)

  assert.ok(closure.size > 100)
  assert.equal(lock.packages["node_modules/fastify"].version, "4.29.1")
  assert.equal(lock.packages["node_modules/undici"].version, "6.28.1")
  assert.equal(lock.packages["packages/server/node_modules/commander"].version, "12.1.0")
  assert.equal(lock.packages["packages/server/node_modules/fuzzysort"].version, "2.0.4")
  assert.equal(closure.has("node_modules/@opencode/plugin"), false, "the opt-in pruning plugin API is not a server production dependency")
})

test("rejects an unpinned production dependency despite an otherwise valid lock", () => {
  const root = path.resolve(__dirname, "..")
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
  delete lock.packages["node_modules/undici"].integrity
  assert.throws(() => validateServerProductionLock(lock), /does not integrity-pin node_modules\/undici/)
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

test("both desktop resource layouts retain a self-contained unified automation bundle", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-automation-resources-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const serverRoot = path.join(root, "source")
  for (const name of ["public", "node_modules"]) fs.mkdirSync(path.join(serverRoot, name), { recursive: true })
  fs.writeFileSync(path.join(serverRoot, "package.json"), JSON.stringify({ type: "module" }))
  const relative = path.join("dist", "plugins", "automation", "plugin.mjs")
  await require("esbuild").build({
    entryPoints: [path.join(__dirname, "../packages/server/src/opencode/automation/desktop-plugin.ts")],
    outfile: path.join(serverRoot, relative), bundle: true, platform: "node", format: "esm", target: "node22",
  })
  for (const host of ["electron", "tauri"]) {
    const serverDest = path.join(root, host, "server")
    copyPackagedServerResources({ serverRoot, serverDest })
    const target = path.join(serverDest, relative)
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.join(serverRoot, relative)))
    const { desktopPlugin } = await import(require("node:url").pathToFileURL(target).href)
    const plugin = desktopPlugin(path.join(root, "absent-presence"))
    assert.equal(plugin.id, "codenomad.automation")
    const cleanup = await plugin.setup({})
    await cleanup()
  }
})
