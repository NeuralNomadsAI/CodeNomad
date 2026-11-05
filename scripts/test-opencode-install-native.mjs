// Standard npm --global install into a fresh synthetic user's prefix.
// No real user PATH/registry/profile changes and no shared daemon.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, cp, copyFile, chmod, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { tsImport } from "tsx/esm/api"
import { fixtureRuntime } from "./opencode-fixture-runtime.mjs"
const { installSharedOpenCode, resolveDefaultInstallation, findPathOpenCode } = await tsImport("../packages/server/src/opencode-update/shared-installation.ts", import.meta.url)
const { registerUserPath } = await tsImport("../packages/server/src/opencode-update/user-path.ts", import.meta.url)
const { MINIMUM_OPENCODE_VERSION } = await tsImport("../packages/server/src/opencode/runtime-support.ts", import.meta.url)
const parent = path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "codenomad-install-native-"))
const runtime = path.join(root, "runtime")
await mkdir(runtime)
const selected = await fixtureRuntime(root)
const node = selected.electron ? selected.node : path.join(runtime, process.platform === "win32" ? "node.exe" : "bin/node")
if (!selected.electron) {
  await mkdir(path.dirname(node), { recursive: true })
  await copyFile(selected.node, node)
  await chmod(node, 0o755)
  const npmRoot = path.resolve(selected.npm, "../..")
  await cp(npmRoot, path.join(runtime, process.platform === "win32" ? "node_modules/npm" : "lib/node_modules/npm"), { recursive: true })
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PATH|OPENCODE_|XDG_|npm_)/i.test(key)))
// npm invokes the OS shell for package lifecycle scripts; provide that shell
// explicitly without admitting /usr/bin/node or any other system Node to PATH.
Object.assign(env, { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, APPDATA: path.join(root, "AppData"),
  ZDOTDIR: root, SHELL: process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
  npm_config_cache: path.join(root, "npm-cache"), npm_config_userconfig: path.join(root, "npmrc"),
  ...selected.env, PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : path.join(root, "tools") })
try {
  let registered = false
  const options = { home: root, node, ...(selected.electron ? { npm: selected.npm } : {}), env, registerPath: directory => registerUserPath(directory, {
    home: root, env, registerWindowsPath: async () => { registered = true },
  }) }
  const binary = await installSharedOpenCode(MINIMUM_OPENCODE_VERSION, options)
  assert.equal(resolveDefaultInstallation(options).source, "path")
  assert.equal(resolveDefaultInstallation(options).path, findPathOpenCode(options))
  if (process.platform === "win32") assert.equal(registered, true)
  assert.match(execFileSync(binary, ["--version"], { encoding: "utf8", env }), new RegExp(MINIMUM_OPENCODE_VERSION.replaceAll(".", "\\.")))
  const terminalVersion = process.platform === "win32"
    ? execFileSync(process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "opencode2 --version"], { cwd: root, encoding: "utf8", env })
    : execFileSync("opencode2", ["--version"], { cwd: root, encoding: "utf8", env })
  assert.match(terminalVersion, new RegExp(MINIMUM_OPENCODE_VERSION.replaceAll(".", "\\.")))
  const commandDirectory = path.dirname(findPathOpenCode(options))
  const removeCommands = () => Promise.all(["opencode", "opencode2"].flatMap(name =>
    (process.platform === "win32" ? ["", ".cmd", ".ps1"] : [""]).map(extension =>
      rm(path.join(commandDirectory, name + extension), { force: true }))))
  await removeCommands()
  await installSharedOpenCode(MINIMUM_OPENCODE_VERSION, options)
  assert.ok(findPathOpenCode(options), "same-version npm install repairs missing terminal commands")
  if (process.platform === "win32") {
    // A private foreground server maps the real OpenCode image for Electron;
    // standalone Node also supports the small mapped-executable fixture.
    const backup = path.join(root, "original-opencode.exe")
    await copyFile(binary, backup)
    if (!selected.electron) await copyFile(node, binary)
    const child = spawn(binary, selected.electron ? ["serve", "--hostname", "127.0.0.1", "--port", "0"]
      : ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    try {
      await once(child.stdout, "data")
      // Same-version repair still uses direct npm/preflight. Missing launchers
      // force that write path instead of the already-satisfied no-op path.
      await removeCommands()
      let executed = false
      await assert.rejects(installSharedOpenCode(MINIMUM_OPENCODE_VERSION, { ...options,
        probe: async () => ({ valid: true, version: MINIMUM_OPENCODE_VERSION }),
        execute: async () => { executed = true },
      }), error => error.code === "installation_in_use")
      assert.equal(executed, false, "npm must not retire the live package")
      assert.equal(child.exitCode, null, "installation never stops a running executable")
    } finally {
      const closed = once(child, "close")
      child.kill()
      await closed
      if (!selected.electron) await copyFile(backup, binary)
    }
    await installSharedOpenCode(MINIMUM_OPENCODE_VERSION, options)
    assert.ok(findPathOpenCode(options), "repair succeeds after the mapped fixture executable exits")
    assert.match(execFileSync(binary, ["--version"], { encoding: "utf8", env }), new RegExp(MINIMUM_OPENCODE_VERSION.replaceAll(".", "\\.")))
    console.log("PASS: Windows live-executable repair deferred before npm; original installation retained")
  }
  console.log(`PASS: shared user npm installation with isolated bundled Node, no system Node PATH; backend and terminal both resolve ${MINIMUM_OPENCODE_VERSION}`)
} finally { await rm(root, { recursive: true, force: true }) }
