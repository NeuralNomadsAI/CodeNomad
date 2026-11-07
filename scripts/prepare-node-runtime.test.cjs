const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const yaml = require("yaml")
const os = require("node:os")
const crypto = require("node:crypto")
const zlib = require("node:zlib")
const { MANAGED_NODE_VERSION, assembleRuntime, installedElectronNodeVersion, npmRelativePath, prepareBundledNodeRuntime } = require("./prepare-node-runtime.cjs")
const { NPM_VERSION, extractNpmTarball } = require("./bundled-npm.cjs")

const root = path.resolve(__dirname, "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

test("pins Tauri's Node to the exact Node 24 LTS used by CI", () => {
  const version = read(".node-version").trim()
  assert.match(version, /^24\.\d+\.\d+$/)
  assert.equal(MANAGED_NODE_VERSION, `v${version}`)
})

test("all Node setup steps use the checked-out runtime pin", () => {
  const workflows = fs.readdirSync(path.join(root, ".github/workflows"))
    .filter((file) => /\.ya?ml$/.test(file))
  let checked = 0
  for (const file of workflows) {
    const workflow = yaml.parse(read(`.github/workflows/${file}`))
    for (const job of Object.values(workflow.jobs ?? {})) {
      const steps = job.steps ?? []
      for (const [index, step] of steps.entries()) {
        if (!step.uses?.startsWith("actions/setup-node@")) continue
        assert.equal(step.with?.["node-version-file"], ".node-version", file)
        assert.equal(step.with?.["node-version"], undefined, file)
        assert.ok(steps.slice(0, index).some((earlier) => earlier.uses?.startsWith("actions/checkout@")), file)
        checked++
      }
    }
  }
  assert.ok(checked > 0)
})

test("both macOS bundles share the minimum required by Tauri's bundled Node 24", () => {
  const electron = JSON.parse(read("packages/electron-app/package.json"))
  const tauri = JSON.parse(read("packages/tauri-app/src-tauri/tauri.conf.json"))
  assert.equal(electron.build.mac.minimumSystemVersion, "13.5")
  assert.equal(tauri.bundle.macOS.minimumSystemVersion, "13.5")
})

test("both hosts' npm is pinned exactly and separately from the Node archive", () => {
  // One exact version line; a Windows checkout may convert its LF to CRLF.
  assert.match(read(".npm-version"), /^\d+\.\d+\.\d+\r?\n$/)
  assert.equal(NPM_VERSION, read(".npm-version").trim())
})

// A registry tarball: ustar entries under package/, as npm publishes them.
function tarball(entries) {
  const blocks = []
  for (const { name, data = "", mode = 0o644, type = "0" } of entries) {
    const body = Buffer.from(data)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100)
    header.write(`${mode.toString(8).padStart(6, "0")} \0`, 100)
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124)
    header.write("        ", 148)
    header.write(type, 156)
    header.write("ustar\u000000", 257)
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  return zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

function npmFixture({ engine = ">=20.0.0", version = NPM_VERSION, extra = [], integrity, tarballUrl } = {}) {
  const semver = JSON.stringify(require.resolve("semver"))
  const body = tarball([
    { name: "package/package.json", data: JSON.stringify({ name: "npm", version, engines: { node: engine }, bundleDependencies: ["semver"] }) },
    { name: "package/LICENSE", data: "npm license" },
    { name: "package/bin/npm-cli.js", data: "#!/usr/bin/env node\n", mode: 0o755 },
    { name: "package/bin/node-gyp-bin/node-gyp", data: "#!/bin/sh\n", mode: 0o755 },
    { name: "package/node_modules/semver/package.json", data: JSON.stringify({ name: "semver" }) },
    { name: "package/node_modules/semver/index.js", data: `module.exports = require(${semver})` },
    ...extra,
  ])
  const requests = []
  const request = async url => {
    requests.push(url)
    if (url === `https://registry.npmjs.org/npm/${NPM_VERSION}`) {
      return Buffer.from(JSON.stringify({ name: "npm", version, dist: {
        tarball: tarballUrl ?? `https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`,
        integrity: integrity ?? `sha512-${crypto.createHash("sha512").update(body).digest("base64")}`,
      } }))
    }
    if (url === `https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`) return body
    throw new Error(`offline fixture: unexpected request ${url}`)
  }
  return { request, requests }
}

function withResources(t) {
  const resourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-npm-resources-"))
  t.after(() => fs.rmSync(resourcesRoot, { recursive: true, force: true }))
  return resourcesRoot
}

test("Electron's npm-only resources hold the verified registry package for every target", async t => {
  for (const target of ["win32-x64", "linux-x64", "darwin-arm64"]) {
    const resourcesRoot = withResources(t)
    const { request, requests } = npmFixture()
    await prepareBundledNodeRuntime({ resourcesRoot, target, npmOnly: true, runtimeNodeVersion: "22.20.0", request })
    const runtime = path.join(resourcesRoot, "node", target)
    assert.deepEqual(fs.readdirSync(runtime), ["npm"])
    assert.ok(fs.existsSync(path.join(runtime, "npm/bin/npm-cli.js")))
    assert.ok(fs.existsSync(path.join(runtime, "npm/node_modules/semver/index.js")))
    assert.equal(fs.readFileSync(path.join(runtime, "npm/LICENSE"), "utf8"), "npm license")
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(runtime, "npm/bin/node-gyp-bin/node-gyp")).mode & 0o111, 0o111)
    assert.ok(requests.every(url => url.startsWith("https://registry.npmjs.org/")), "npm-only resources skip the Node archive")
  }
})

test("Tauri's layout keeps the archive's Node and license beside the pinned npm where bundledNpm() looks", t => {
  for (const [target, binary, npm] of [["win32-x64", "node.exe", "node_modules/npm"], ["linux-x64", "bin/node", "lib/node_modules/npm"], ["darwin-x64", "bin/node", "lib/node_modules/npm"]]) {
    const root = withResources(t)
    const nodeRoot = path.join(root, "archive")
    const npmRoot = path.join(root, "npm")
    for (const [file, data] of [[path.join(nodeRoot, binary), "node"], [path.join(nodeRoot, "LICENSE"), "node license"],
      [path.join(nodeRoot, npm, "bin/npm-cli.js"), "archive npm"], [path.join(npmRoot, "bin/npm-cli.js"), "pinned npm"], [path.join(npmRoot, "LICENSE"), "npm license"]]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, data)
    }
    const destinationRoot = path.join(root, "out")
    assembleRuntime({ nodeRoot, npmRoot, destinationRoot, target, binaryRelativePath: binary })
    assert.equal(npmRelativePath(target, false), path.normalize(npm))
    assert.equal(fs.readFileSync(path.join(destinationRoot, binary), "utf8"), "node")
    assert.equal(fs.readFileSync(path.join(destinationRoot, "LICENSE"), "utf8"), "node license")
    assert.equal(fs.readFileSync(path.join(destinationRoot, npm, "bin/npm-cli.js"), "utf8"), "pinned npm")
    assert.equal(fs.readFileSync(path.join(destinationRoot, npm, "LICENSE"), "utf8"), "npm license")
    assert.deepEqual(fs.readdirSync(destinationRoot).sort(), [binary.split("/")[0], "LICENSE", npm.split("/")[0]].sort())
  }
  const npmRuntime = read("packages/server/src/opencode-update/npm-runtime.ts")
  for (const candidate of ['"node", target, "npm", "bin", "npm-cli.js"', '"node_modules", "npm", "bin", "npm-cli.js"', '"..", "lib", "node_modules", "npm", "bin", "npm-cli.js"']) {
    assert.ok(npmRuntime.includes(candidate), candidate)
  }
})

test("a registry package whose integrity, URL or version does not match fails before resources are written", async t => {
  for (const options of [{ integrity: "sha512-AAAA" }, { integrity: "sha1-AAAA" }, { integrity: "" },
    { tarballUrl: "https://example.com/npm.tgz" }, { version: "0.0.1" }]) {
    const resourcesRoot = withResources(t)
    await assert.rejects(prepareBundledNodeRuntime({ resourcesRoot, target: "win32-x64", npmOnly: true, runtimeNodeVersion: "22.20.0",
      request: npmFixture(options).request }), /Integrity mismatch|no sha512|Unexpected registry metadata/)
    assert.equal(fs.existsSync(path.join(resourcesRoot, "node")), false)
  }
})

test("both hosts refuse an npm whose engines reject the Node it will run under", async t => {
  const engine = ">=99.0.0"
  const electron = withResources(t)
  await assert.rejects(prepareBundledNodeRuntime({ resourcesRoot: electron, target: "linux-x64", npmOnly: true, runtimeNodeVersion: "22.20.0",
    request: npmFixture({ engine }).request }), /requires Node >=99\.0\.0, but Electron's integrated runtime runs Node 22\.20\.0/)
  assert.equal(fs.existsSync(path.join(electron, "node")), false)
  // Tauri's guard uses .node-version and runs before the Node archive is requested.
  const tauri = withResources(t)
  const { request, requests } = npmFixture({ engine })
  await assert.rejects(prepareBundledNodeRuntime({ resourcesRoot: tauri, target: "linux-x64", request }),
    new RegExp(`but Tauri's bundled runtime runs Node ${read(".node-version").trim().replaceAll(".", "\\.")}`))
  assert.ok(requests.every(url => url.startsWith("https://registry.npmjs.org/")))
  assert.equal(fs.existsSync(path.join(tauri, "node")), false)
})

test("npm package extraction refuses links, escapes and foreign roots", t => {
  for (const name of ["package/../escape.js", "package/link", "package/hard", "other/file.js", "/package/absolute.js"]) {
    const destination = withResources(t)
    const type = name === "package/link" ? "2" : name === "package/hard" ? "1" : "0"
    assert.throws(() => extractNpmTarball(tarball([{ name: "package/package.json", data: "{}" }, { name, type }]), destination),
      /Unexpected npm package path|Unsupported npm package entry type/)
    assert.equal(fs.existsSync(path.join(destination, "..", "escape.js")), false)
  }
})

test("npm package extraction follows pax long paths", t => {
  const destination = withResources(t)
  const long = `package/node_modules/${"a".repeat(80)}/${"b".repeat(80)}/index.js`
  const body = ` path=${long}\n`
  let length = body.length + 1
  while (String(length).length + body.length !== length) length = String(length).length + body.length
  extractNpmTarball(tarball([{ name: "PaxHeader/index.js", type: "x", data: `${length}${body}` }, { name: "package/truncated", data: "pax" }]), destination)
  assert.equal(fs.readFileSync(path.join(destination, ...long.slice("package/".length).split("/")), "utf8"), "pax")
  assert.equal(fs.existsSync(path.join(destination, "truncated")), false)
})

test("Electron's integrated Node version comes from the installed executable", () => {
  const version = installedElectronNodeVersion()
  assert.match(version, /^\d+\.\d+\.\d+$/)
})
