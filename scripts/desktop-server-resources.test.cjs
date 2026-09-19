const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const {
  materializePrebuiltWorkspacePackage,
  resolveNpmTarget,
  stagePrebuiltWorkspacePackage,
  validateServerProductionLock,
} = require("./desktop-server-resources.cjs")
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

test("integrity-pins the full server production closure in the root lock", () => {
  const root = path.resolve(__dirname, "..")
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
  const closure = validateServerProductionLock(lock)

  assert.ok(closure.size > 100)
  assert.equal(lock.packages["node_modules/fastify"].version, "4.29.1")
  assert.equal(lock.packages["node_modules/undici"].version, "6.28.1")
  assert.equal(lock.packages["packages/server/node_modules/commander"].version, "12.1.0")
  assert.equal(lock.packages["packages/server/node_modules/fuzzysort"].version, "2.0.4")
  assert.ok(closure.has("packages/remote-control-protocol"))
  assert.equal(closure.has("node_modules/@opencode/plugin"), false, "the opt-in pruning plugin API is not a server production dependency")
})

test("stages prebuilt workspace packages without install lifecycle scripts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-workspace-stage-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, "source")
  const destination = path.join(root, "destination")
  fs.mkdirSync(path.join(source, "dist"), { recursive: true })
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({
    name: "@codenomad/example",
    version: "1.0.0",
    scripts: { prepare: "npm run build" },
  }))
  fs.writeFileSync(path.join(source, "dist", "index.js"), "export {}\n")

  stagePrebuiltWorkspacePackage(source, destination)

  const manifest = JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8"))
  assert.equal(manifest.scripts, undefined)
  assert.equal(fs.readFileSync(path.join(destination, "dist", "index.js"), "utf8"), "export {}\n")
})

test("materializes workspace packages instead of retaining install links", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-workspace-materialize-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, "source")
  const linkedSource = path.join(root, "linked-source")
  const nodeModules = path.join(root, "node_modules")
  const destination = path.join(nodeModules, "@codenomad", "example")
  fs.mkdirSync(path.join(source, "dist"), { recursive: true })
  fs.mkdirSync(linkedSource, { recursive: true })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({
    name: "@codenomad/example",
    version: "1.0.0",
    scripts: { prepare: "npm run build" },
  }))
  fs.writeFileSync(path.join(source, "dist", "index.js"), "export const value = 'packaged'\n")
  fs.writeFileSync(path.join(linkedSource, "sentinel"), "keep\n")
  fs.symlinkSync(linkedSource, destination, process.platform === "win32" ? "junction" : "dir")

  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true)
  assert.equal(materializePrebuiltWorkspacePackage(source, nodeModules), destination)

  assert.equal(fs.lstatSync(destination).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(path.join(destination, "dist", "index.js"), "utf8"), "export const value = 'packaged'\n")
  assert.equal(fs.readFileSync(path.join(linkedSource, "sentinel"), "utf8"), "keep\n")
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8"))
  assert.equal(manifest.scripts, undefined)
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
