import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildUpgradeCommand, detectPackageManager, formatUpgradeCommand } from "./cli-upgrade"

describe("cli upgrade", () => {
  it("defaults to npm when no package manager can be detected", () => {
    assert.equal(detectPackageManager({}), "npm")
  })

  it("detects package managers from npm user agent", () => {
    assert.equal(detectPackageManager({ npm_config_user_agent: "pnpm/9.0.0 node/v22" }), "pnpm")
    assert.equal(detectPackageManager({ npm_config_user_agent: "bun/1.0.0" }), "bun")
    assert.equal(detectPackageManager({ npm_config_user_agent: "npm/10.0.0 node/v22" }), "npm")
  })

  it("builds latest upgrade command by default", () => {
    const command = buildUpgradeCommand(undefined, "npm")

    assert.equal(command.packageSpec, "@neuralnomads/codenomad@latest")
    assert.deepEqual(command.args, ["install", "-g", "@neuralnomads/codenomad@latest"])
    assert.equal(formatUpgradeCommand(command), "npm install -g @neuralnomads/codenomad@latest")
  })

  it("builds a versioned upgrade command", () => {
    const command = buildUpgradeCommand("0.10.5", "pnpm")

    assert.equal(command.packageSpec, "@neuralnomads/codenomad@0.10.5")
    assert.deepEqual(command.args, ["install", "-g", "@neuralnomads/codenomad@0.10.5"])
    assert.equal(formatUpgradeCommand(command), "pnpm install -g @neuralnomads/codenomad@0.10.5")
  })
})
