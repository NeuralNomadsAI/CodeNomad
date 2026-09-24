const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const yaml = require("yaml")
const os = require("node:os")
const { MANAGED_NODE_VERSION } = require("./prepare-node-runtime.cjs")

const root = path.resolve(__dirname, "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

test("pins the bundled runtime to the exact Node 24 LTS used by CI", () => {
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

test("both macOS bundles require the OS supported by Node 24", () => {
  const electron = JSON.parse(read("packages/electron-app/package.json"))
  const tauri = JSON.parse(read("packages/tauri-app/src-tauri/tauri.conf.json"))
  assert.equal(electron.build.mac.minimumSystemVersion, "13.5")
  assert.equal(tauri.bundle.macOS.minimumSystemVersion, "13.5")
})

test("both desktop resource layouts retain the complete npm runtime and licenses", () => {
  const { pruneForRuntime } = require("./prepare-node-runtime.cjs")
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-node-packaging-"))
  try {
    for (const binary of ["node.exe", "bin/node"]) {
      const source = path.join(fixture, binary === "node.exe" ? "windows" : "posix")
      const destination = `${source}-out`
      const npm = binary === "node.exe" ? "node_modules/npm" : "lib/node_modules/npm"
      for (const file of [binary, "LICENSE", `${npm}/bin/npm-cli.js`, `${npm}/node_modules/fixture/index.js`, `${npm}/LICENSE`]) {
        fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true })
        fs.writeFileSync(path.join(source, file), file)
      }
      pruneForRuntime(source, destination, binary)
      assert.equal(fs.readFileSync(path.join(destination, `${npm}/node_modules/fixture/index.js`), "utf8"), `${npm}/node_modules/fixture/index.js`)
      assert.ok(fs.existsSync(path.join(destination, "LICENSE")))
      assert.ok(fs.existsSync(path.join(destination, `${npm}/bin/npm-cli.js`)))
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})
