import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { legacyOpenCodeRemoval } from "./legacy-package"
import { installOpenCodeCli } from "./service"

test("identifies old npm and pnpm shims without removing the current package", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codenomad-update-shim-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const shim = path.join(root, "opencode2.cmd")
  writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node_modules\\@opencode-ai\\cli\\bin\\opencode2.exe" %*\r\n')
  assert.deepEqual(legacyOpenCodeRemoval(shim, "npm"), {
    command: "npm", args: ["uninstall", "-g", "@opencode-ai/cli"],
  })
  writeFileSync(shim, '"%~dp0%\\global\\5\\node_modules\\@opencode-ai\\cli\\bin\\opencode2.exe" %*\r\n')
  assert.deepEqual(legacyOpenCodeRemoval(shim, "pnpm"), {
    command: "pnpm", args: ["remove", "-g", "@opencode-ai/cli"],
  })
  writeFileSync(shim, '"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe" %*\r\n')
  assert.equal(legacyOpenCodeRemoval(shim, "npm"), undefined)
  writeFileSync(shim, '# unrelated wrapper named opencode2\necho "custom"\n')
  assert.equal(legacyOpenCodeRemoval(shim, "npm"), undefined)
  assert.equal(legacyOpenCodeRemoval(path.join(root, "missing"), "npm"), undefined)
})

test("recognizes a linked native entry point without reading its executable contents", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codenomad-update-link-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, "node_modules", "@opencode-ai", "cli", "bin")
  mkdirSync(bin, { recursive: true })
  const target = path.join(bin, "opencode2.exe")
  writeFileSync(target, Buffer.alloc(70 * 1024))
  const link = path.join(root, "linked-bin")
  symlinkSync(bin, link, process.platform === "win32" ? "junction" : "dir")
  assert.deepEqual(legacyOpenCodeRemoval(path.join(link, "opencode2.exe"), "bun"), {
    command: "bun", args: ["remove", "-g", "@opencode-ai/cli"],
  })
  assert.deepEqual(legacyOpenCodeRemoval(path.join(link, "opencode2.exe"), "yarn"), {
    command: "yarn", args: ["global", "remove", "@opencode-ai/cli"],
  })
  const standalone = path.join(root, "opencode2.exe")
  writeFileSync(standalone, Buffer.alloc(70 * 1024))
  assert.equal(legacyOpenCodeRemoval(standalone, "npm"), undefined)
})

test("migration waits for legacy removal and aborts installation when removal fails", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codenomad-update-migration-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const shim = path.join(root, "opencode2.cmd")
  writeFileSync(shim, '"%dp0%\\node_modules\\@opencode-ai\\cli\\bin\\opencode2.exe" %*\r\n')
  const calls: string[][] = []
  let removalExitCode = 0
  t.mock.method(childProcess, "spawn", (command: string, args: string[]) => {
    calls.push([command, ...args])
    const child = new EventEmitter()
    queueMicrotask(() => child.emit("exit", args.includes("uninstall") ? removalExitCode : 0, null))
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const env = { npm_config_prefix: root, npm_config_cache: path.join(root, "cache") }
  const binary = { path: shim, label: "fixture" }
  assert.deepEqual(await installOpenCodeCli(binary, "2.0.10", env), { success: true, version: "2.0.10" })
  assert.deepEqual(calls, [
    ["npm", "uninstall", "-g", "@opencode-ai/cli"],
    ["npm", "install", "-g", "@opencode/cli@2.0.10"],
  ])
  calls.length = 0
  removalExitCode = 1
  assert.equal((await installOpenCodeCli(binary, "2.0.10", env)).success, false)
  assert.deepEqual(calls, [["npm", "uninstall", "-g", "@opencode-ai/cli"]])
  calls.length = 0
  writeFileSync(shim, '"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe" %*\r\n')
  assert.equal((await installOpenCodeCli(binary, "2.0.10", env)).success, true)
  assert.deepEqual(calls, [["npm", "install", "-g", "@opencode/cli@2.0.10"]])
})
