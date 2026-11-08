const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const yaml = require("yaml")

const { cargoLock, electronTargets, linkElectronZips, outputs, spec, verifyCrates } = require("./download-cache.cjs")

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex")
const workflow = (name) => yaml.parse(fs.readFileSync(path.join(__dirname, "../workflows", name), "utf8"), { strict: true, uniqueKeys: true })
const packageLock = JSON.stringify({ packages: {
  "node_modules/electron": { version: "45.2.3" },
  "node_modules/app-builder-bin": { version: "4.0.0" },
  "node_modules/@tauri-apps/cli": { version: "2.12.4" },
} })
const crate = (name, version, checksum, source = "registry+https://github.com/rust-lang/crates.io-index") =>
  `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "${source}"\nchecksum = "${checksum}"\n`
const linux = { env: {}, platform: "linux", arch: "x64", home: "/home/runner" }
const windows = { env: { LOCALAPPDATA: "C:\\Users\\runneradmin\\AppData\\Local" }, platform: "win32", arch: "x64", home: "C:\\Users\\runneradmin" }
const mac = { env: {}, platform: "darwin", arch: "x64", home: "/Users/runner" }

test("Electron caches are keyed by the locked Electron and app-builder versions in each tool's directory", () => {
  const inputs = { packageLock }
  assert.deepEqual(spec("electron", linux, inputs), {
    key: "electron-linux-x64-45.2.3-app-builder-bin-4.0.0",
    paths: [path.join("/home/runner/.cache", "electron"), path.join("/home/runner/.cache", "electron-builder")],
  })
  assert.deepEqual(spec("electron", windows, inputs).paths, [
    path.join(windows.env.LOCALAPPDATA, "electron", "Cache"), path.join(windows.env.LOCALAPPDATA, "electron-builder", "Cache"),
  ])
  assert.deepEqual(spec("electron", mac, inputs).paths, [path.join("/Users/runner/Library/Caches", "electron")])
  for (const name of ["electron_config_cache", "ELECTRON_CACHE", "ELECTRON_BUILDER_CACHE"]) {
    assert.equal(spec("electron", { ...linux, env: { [name]: "/elsewhere" } }, inputs), null, name)
  }
  assert.deepEqual(electronTargets(mac), ["darwin-x64", "darwin-arm64"], "the Intel build packages both architectures")
  assert.deepEqual(electronTargets({ platform: "darwin", arch: "arm64" }), ["darwin-arm64"])
  assert.deepEqual(electronTargets(windows), ["win32-x64"])
})

test("Cargo caches only download directories, keyed by the lockfile whatever its line endings", () => {
  const lock = crate("serde", "1.0.0", "aa")
  const result = spec("cargo", linux, { cargoLock: lock })
  assert.deepEqual(result.paths, [
    path.join("/home/runner", ".cargo", "registry", "index"), path.join("/home/runner", ".cargo", "registry", "cache"),
  ])
  assert.equal(result.key, `cargo-linux-x64-${sha256(lock)}`)
  assert.equal(result.restoreKeys, "cargo-linux-x64-")
  assert.equal(spec("cargo", linux, { cargoLock: lock.replace(/\n/g, "\r\n") }).key, result.key)
  assert.equal(spec("cargo", { ...linux, env: { CARGO_HOME: "/opt/cargo" } }, { cargoLock: lock }), null)
  const git = spec("cargo", linux, { cargoLock: lock + crate("x", "0.1.0", "bb", "git+https://example.invalid/x#abc") })
  assert.ok(git.paths.includes(path.join("/home/runner", ".cargo", "git", "db")))
})

test("Tauri and AppImage runtime caches exist only where the bundler downloads", () => {
  const digest = "a".repeat(64)
  assert.deepEqual(spec("tauri", linux, { packageLock, pluginDigest: digest }), {
    key: `tauri-linux-x64-2.12.4-${digest}`, paths: [path.join("/home/runner/.cache", "tauri")],
  }, "the continuous AppImage plugin's digest keys the Linux tools")
  assert.equal(spec("tauri", linux, { packageLock }), null)
  assert.deepEqual(spec("tauri", windows, { packageLock }), {
    key: "tauri-win32-x64-2.12.4", paths: [path.join(windows.env.LOCALAPPDATA, "tauri")],
  })
  assert.equal(spec("tauri", mac, { packageLock }), null)
  assert.equal(spec("appimage-runtime", linux, { runtimeDigest: digest }).key, `appimage-runtime-x86_64-${digest}`)
  assert.equal(spec("appimage-runtime", linux, { runtimeDigest: undefined }), null, "no digest, no cache")
  assert.equal(spec("appimage-runtime", windows, { runtimeDigest: digest }), null)
  assert.equal(outputs(null), "")
  assert.equal(outputs({ key: "k", paths: ["a", "b"], restoreKeys: "k-" }), "key=k\npath<<__PATHS__\na\nb\n__PATHS__\nrestore-keys=k-\n")
})

test("restored crates that Cargo.lock does not verify are removed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "download-cache-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const registry = path.join(dir, "index.crates.io-1949cf8c6b5b557f")
  fs.mkdirSync(registry)
  const files = { "good-1.0.0.crate": "good", "tampered-1.0.0.crate": "tampered", "unlocked-1.0.0.crate": "x" }
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(registry, name), data)
  const crates = cargoLock(crate("good", "1.0.0", sha256("good")) + crate("tampered", "1.0.0", sha256("original"))
    + crate("local", "0.1.0", "cc", "path+file:///x"))
  assert.deepEqual([...crates.keys()], ["good-1.0.0.crate", "tampered-1.0.0.crate"])
  assert.equal(verifyCrates(path.join(dir, "cache"), crates), 0, "a missing cache is empty")
  assert.equal(verifyCrates(dir, crates), 2)
  assert.deepEqual(fs.readdirSync(registry), ["good-1.0.0.crate"])
})

test("electron-builder receives only Electron zips matching electron's checksums", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "download-cache-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const host = { env: {}, platform: "darwin", arch: "x64", home }
  const store = path.join(home, "Library", "Caches", "electron")
  const zip = (target) => `electron-v45.2.3-${target}.zip`
  fs.mkdirSync(path.join(store, "0123"), { recursive: true })
  fs.writeFileSync(path.join(store, "0123", zip("darwin-x64")), "x64")
  fs.writeFileSync(path.join(store, "0123", zip("darwin-arm64")), "tampered")
  linkElectronZips(host, "45.2.3", { [zip("darwin-x64")]: sha256("x64"), [zip("darwin-arm64")]: sha256("arm64") })
  assert.equal(fs.readFileSync(path.join(store, zip("darwin-x64")), "utf8"), "x64")
  assert.equal(fs.existsSync(path.join(store, zip("darwin-arm64"))), false, "electron-builder downloads it")
  assert.equal(fs.existsSync(path.join(store, "0123", zip("darwin-arm64"))), false)
})

test("only trusted dev runs write caches, and jobs restore before downloading", () => {
  for (const name of ["pr-build.yml", "signpath-test-signing.yml"]) {
    assert.equal(workflow(name)["cache-mode"], "read", name)
  }
  const seed = workflow("download-cache.yml")
  assert.deepEqual(Object.keys(seed.on), ["push", "schedule", "workflow_dispatch"])
  assert.deepEqual(seed.on.push.branches, ["dev"])
  assert.equal(seed.jobs.seed.if, "github.ref == 'refs/heads/dev'")
  assert.deepEqual(seed.permissions, { contents: "read" })
  for (const name of fs.readdirSync(path.join(__dirname, "../workflows"))) {
    for (const [id, job] of Object.entries(workflow(name).jobs ?? {})) {
      const steps = job.steps ?? []
      steps.forEach((step, index) => {
        const where = `${name} ${id}: ${step.name ?? step.uses}`
        if (/^actions\/cache(\/save)?@/.test(step.uses ?? "")) {
          assert.ok(name === "download-cache.yml" || step.if?.includes("github.event_name == 'schedule' && github.ref == 'refs/heads/dev'"), where)
        }
        assert.doesNotMatch(step.uses ?? "", /^actions\/cache(\/restore|\/save)?@(?!v6\.1\.0$)/, where)
        // A pull request branch without these files runs exactly as before them.
        if (name !== "download-cache.yml" && (step.uses === "./.github/actions/download-cache" || /download-cache\.cjs/.test(step.run ?? ""))) {
          assert.ok(step.if?.includes("hashFiles('.github/actions/download-cache/action.yml') != ''"), `${where} is guarded`)
          assert.ok(steps.slice(0, index).some((s) => s.uses?.startsWith("actions/checkout@")), `${where} follows checkout`)
        }
        if (/npx --no install-electron/.test(step.run ?? "") && name !== "download-cache.yml") {
          assert.ok(steps.slice(0, index).some((s) => s.uses === "./.github/actions/download-cache" && s.with?.kind === "electron"), where)
        }
        if (/build:(mac|win|linux) --workspace @neuralnomads\/codenomad-electron-app/.test(step.run ?? "")) {
          assert.match(steps[index - 1].run ?? "", /download-cache\.cjs link electron/, where)
        }
      })
    }
  }
})
