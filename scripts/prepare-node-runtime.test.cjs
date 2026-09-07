const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const yaml = require("yaml")
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
