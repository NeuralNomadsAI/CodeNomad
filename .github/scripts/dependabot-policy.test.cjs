const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const yaml = require("yaml")

const source = fs.readFileSync(path.join(__dirname, "../dependabot.yml"), "utf8")
const parse = (text) => yaml.parse(text, { strict: true, uniqueKeys: true })
const minorPatch = ["version-update:semver-minor", "version-update:semver-patch"]
const allDependencies = { "dependency-type": "all", "update-types": minorPatch }
const electronMajor = { "dependency-name": "electron", "update-types": ["version-update:semver-major"] }
const versionGroup = (patterns) => ({
  "applies-to": "version-updates", patterns, "update-types": ["minor", "patch"],
})

// Assert the configuration contract, leaving update resolution to Dependabot.
// Upstream Job#collect_permitted_update_types unions matching allow rules;
// Job#ignored_versions_from_allowed_update_types bypasses security updates.
// GroupUpdateAllVersions#perform runs individual updates after security groups;
// DependencyGroupEngine keeps unmatched dependencies ungrouped.
function assertPolicy(config) {
  assert.equal(config.version, 2)
  assert.deepEqual(config.updates.map((entry) => [entry["package-ecosystem"], entry.directory ?? entry.directories]), [
    ["cargo", "/packages/tauri-app"], ["github-actions", "/"], ["npm", "/"], ["npm", "/packages/cloudflare"],
  ])
  for (const entry of config.updates) {
    assert.equal(entry.schedule.interval, "weekly")
    assert.equal(entry["open-pull-requests-limit"], 0, "routine version updates stay off; security updates are separate")
    assert.equal(entry.ignore, undefined, "keep security fixes eligible at every version")
    assert.equal(entry["exclude-paths"], undefined, "cover every workspace manifest")
    assert.equal(entry.vendor, undefined, "local Cargo patches require manual re-qualification")
  }
  const [cargo, actions, npm, cloudflare] = config.updates
  assert.equal(cargo["target-branch"], undefined, "share default-branch configuration with security updates")
  assert.equal(npm["target-branch"], undefined, "share default-branch configuration with security updates")
  assert.equal(cloudflare["target-branch"], undefined, "keep worker security updates on the default branch")
  assert.equal(actions["target-branch"], "dev")
  assert.deepEqual(cargo.allow, [allDependencies], "all crates, including transitives; routine minor/patch only")
  assert.deepEqual(npm.allow, [allDependencies, electronMajor], "all npm names; only Electron adds routine majors")
  assert.deepEqual(cloudflare.allow, [allDependencies], "worker updates keep independent all-package security coverage")
  assert.deepEqual(cloudflare.groups, {
    "cloudflare-security": { "applies-to": "security-updates", patterns: ["wrangler", "miniflare", "workerd", "@cloudflare/*"] },
  }, "only the related worker toolchain shares a security group")
  assert.equal(actions.allow, undefined)
  assert.equal(actions.groups, undefined)
  assert.deepEqual(Object.keys(cargo.groups), ["tauri-security", "tauri"],
    "only related Tauri updates share a group")
  assert.deepEqual(cargo.groups, {
    "tauri-security": { "applies-to": "security-updates", patterns: ["tauri", "tauri-*", "wry"] },
    tauri: versionGroup(["tauri", "tauri-*", "wry"]),
  })
  assert.deepEqual(Object.keys(npm.groups), ["fastify-security", "electron-toolchain", "tauri-js", "opencode-sdk"],
    "only related families share a group; Electron majors stay individual")
  assert.deepEqual(npm.groups, {
    "fastify-security": { "applies-to": "security-updates", patterns: ["fastify", "@fastify/*"] },
    "electron-toolchain": versionGroup(["electron", "electron-builder", "electron-vite"]),
    "tauri-js": versionGroup(["@tauri-apps/*"]),
    "opencode-sdk": versionGroup(["@opencode/client", "@opencode/schema", "@opencode/plugin"]),
  })
}

test("Dependabot keeps broad security coverage and bounded routine updates", () => {
  assertPolicy(parse(source))
})

test("policy check rejects security restrictions, broad majors and incorrect grouping", () => {
  const mutations = [
    ...[0, 1, 2, 3].map(index => (config) => { config.updates[index]["open-pull-requests-limit"] = 1 }),
    (config) => { config.updates[0].allow[0]["dependency-name"] = "tauri*" },
    (config) => { config.updates[0].allow[0]["dependency-type"] = "direct" },
    (config) => { config.updates[0]["target-branch"] = "other-branch" },
    (config) => { config.updates[2].allow[0]["update-types"].push("version-update:semver-major") },
    (config) => { delete config.updates[2].allow[0]["update-types"] },
    (config) => { config.updates[2].allow.pop() },
    (config) => { config.updates[2].ignore = [{ "dependency-name": "*" }] },
    (config) => { config.updates[0].groups.catchall = versionGroup(["*"]) },
    (config) => { config.updates[0].groups["tauri-security"].patterns.push("*") },
    (config) => { config.updates[2].groups["fastify-security"].patterns = ["*"] },
    (config) => { config.updates[0].groups["tauri-security"]["update-types"] = ["minor", "patch"] },
    (config) => { config.updates[2].groups["fastify-security"]["update-types"] = ["minor", "patch"] },
    (config) => { delete config.updates[0].groups["tauri-security"] },
    (config) => { delete config.updates[2].groups["fastify-security"] },
    (config) => { config.updates.pop() },
    (config) => { config.updates[2].directories = ["/", "/packages/cloudflare"]; delete config.updates[2].directory },
    (config) => { config.updates[2].groups.catchall = versionGroup(["*"]) },
    (config) => { config.updates[2].groups["opencode-sdk"]["update-types"].push("major") },
    (config) => { config.updates[3].allow[0]["dependency-name"] = "wrangler" },
    (config) => { config.updates[3].allow.push(electronMajor) },
    (config) => { config.updates[3]["target-branch"] = "other-branch" },
    (config) => { config.updates[3].groups = { catchall: versionGroup(["*"]) } },
    (config) => { config.updates[0].groups = Object.fromEntries(Object.entries(config.updates[0].groups).reverse()) },
  ]
  for (const mutate of mutations) {
    const config = parse(source)
    mutate(config)
    assert.throws(() => assertPolicy(config), assert.AssertionError)
  }
})

test("policy YAML rejects duplicate keys", () => {
  assert.throws(() => parse(`${source}\nversion: 2\n`), { code: "DUPLICATE_KEY" })
})
