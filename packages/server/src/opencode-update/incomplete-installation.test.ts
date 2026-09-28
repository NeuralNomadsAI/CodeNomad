import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isIncompleteWindowsNpmShim } from "./incomplete-installation"
import { installSharedOpenCode, npmExecutable, resolveDefaultInstallation, sharedInstallPrefix } from "./shared-installation"
import { OpenCodeUpdateService } from "./service"

const shim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*\r\n'

test("failed npm installation remains repairable with orphan shims and no package manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-incomplete-"))
  try {
    const prefix = path.join(root, "npm")
    await mkdir(prefix)
    const command = path.join(prefix, "opencode2.cmd")
    await writeFile(command, shim)
    await writeFile(path.join(prefix, "opencode.cmd"), shim)
    const host = { home: root, platform: "win32" as const, env: { PATH: "", npm_config_prefix: prefix } }
    assert.equal(sharedInstallPrefix(host), prefix, "initial failure before PATH registration must allow retry")
    host.env.PATH = prefix
    assert.equal(sharedInstallPrefix(host), prefix)
    assert.deepEqual(resolveDefaultInstallation(host), { path: npmExecutable(prefix, "win32"), source: "user" },
      "probe the missing executable instead of reporting an invalid cmd wrapper")
    const binary = npmExecutable(prefix, "win32")
    await mkdir(path.dirname(binary), { recursive: true })
    await writeFile(binary, "existing unverified executable")
    assert.equal(sharedInstallPrefix(host), undefined, "existing unverified binaries are not incomplete installs")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("an explicit retry repairs leftover launchers and restores update status", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-retry-"))
  try {
    const prefix = path.join(root, "npm")
    await mkdir(prefix)
    await writeFile(path.join(prefix, "opencode2.cmd"), shim)
    const host = { home: root, env: { PATH: prefix, npm_config_prefix: prefix } }
    const binary = npmExecutable(prefix)
    const probe = async (file: string) => {
      try { return { valid: true, version: await readFile(file.endsWith(".cmd") ? binary : file, "utf8") } }
      catch { return { valid: false, missing: true } }
    }
    let installs = 0
    const service = new OpenCodeUpdateService({
      resolveBinary: () => ({ ...resolveDefaultInstallation(host), label: "fixture" }),
      probeBinary: probe,
      resolveLatestVersion: async () => "2.0.16",
      canUpgradeBinary: () => Boolean(sharedInstallPrefix(host)),
      upgradeBinary: async (_binary, version) => {
        await installSharedOpenCode(version, { ...host, npm: "fixture-npm.js", probe, registerPath: async () => {},
          execute: async () => {
            installs++
            await mkdir(path.dirname(binary), { recursive: true })
            await writeFile(binary, version)
            await writeFile(path.join(path.dirname(binary), "../package.json"), JSON.stringify({
              name: "@opencode/cli", bin: { opencode2: "./bin/opencode.exe" },
            }))
          },
        })
        return { success: true, version }
      },
    })
    const before = await service.getStatus()
    assert.equal(before.state, "missing")
    assert.equal(before.canUpgrade, true, "the install button remains available after the failed npm cleanup")
    await service.upgrade()
    assert.equal(installs, 1)
    assert.equal(sharedInstallPrefix(host), prefix)
    assert.equal(resolveDefaultInstallation(host).source, "path")
    assert.equal((await service.getStatus()).state, "ready")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("incomplete-installation recovery does not adopt custom wrappers or other prefixes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-incomplete-authority-"))
  try {
    const command = path.join(root, "opencode2.cmd")
    const binary = npmExecutable(root, "win32")
    await writeFile(command, shim)
    assert.equal(isIncompleteWindowsNpmShim(command, root, binary), true)
    assert.equal(isIncompleteWindowsNpmShim(command, path.join(root, "other"), binary), false)
    for (const custom of [shim + 'echo custom\r\n', shim.replace('opencode.exe', 'custom.exe'),
      '@echo off\r\n"%~dp0\\node_modules\\@opencode\\cli\\bin\\opencode.exe" %*\r\n']) {
      await writeFile(command, custom)
      assert.equal(isIncompleteWindowsNpmShim(command, root, binary), false)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
