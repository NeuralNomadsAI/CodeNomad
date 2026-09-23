// Standard npm --global install into a fresh synthetic user's prefix.
// No real user PATH/registry/profile changes and no shared daemon.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, cp, copyFile, chmod, rm, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { tsImport } from "tsx/esm/api"
const { bundledNpm } = await tsImport("../packages/server/src/opencode-update/npm-runtime.ts", import.meta.url)
const { installSharedOpenCode, resolveDefaultInstallation, findPathOpenCode } = await tsImport("../packages/server/src/opencode-update/shared-installation.ts", import.meta.url)
const { registerUserPath } = await tsImport("../packages/server/src/opencode-update/user-path.ts", import.meta.url)
const { MINIMUM_OPENCODE_VERSION } = await tsImport("../packages/server/src/opencode/runtime-support.ts", import.meta.url)
const parent = path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "codenomad-install-native-"))
const runtime = path.join(root, "runtime")
await mkdir(runtime)
const node = path.join(runtime, process.platform === "win32" ? "node.exe" : "bin/node")
await mkdir(path.dirname(node), { recursive: true })
await copyFile(process.execPath, node)
await chmod(node, 0o755)
const npm = bundledNpm()
assert.ok(npm, "Fixture requires the npm from its Node installation")
const npmRoot = path.resolve(npm, "../..")
await cp(npmRoot, path.join(runtime, process.platform === "win32" ? "node_modules/npm" : "lib/node_modules/npm"), { recursive: true })
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PATH|OPENCODE_|XDG_|npm_)/i.test(key)))
const tools = path.join(root, "tools")
await mkdir(tools)
// npm invokes the OS shell for package lifecycle scripts; provide that shell
// explicitly without admitting /usr/bin/node or any other system Node to PATH.
if (process.platform !== "win32") await symlink("/bin/sh", path.join(tools, "sh"))
Object.assign(env, { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, APPDATA: path.join(root, "AppData"),
  ZDOTDIR: root, SHELL: process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
  npm_config_cache: path.join(root, "npm-cache"), npm_config_userconfig: path.join(root, "npmrc"),
  PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : tools })
try {
  let registered = false
  const options = { home: root, node, env, registerPath: directory => registerUserPath(directory, {
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
  for (const name of ["opencode", "opencode2"]) {
    for (const extension of process.platform === "win32" ? ["", ".cmd", ".ps1"] : [""]) {
      await rm(path.join(commandDirectory, name + extension), { force: true })
    }
  }
  await installSharedOpenCode(MINIMUM_OPENCODE_VERSION, options)
  assert.ok(findPathOpenCode(options), "same-version npm install repairs missing terminal commands")
  if (process.platform === "win32") {
    // A mapped test executable reproduces the Windows lock without ever starting
    // OpenCode's daemon, even in this synthetic home.
    const backup = path.join(root, "original-opencode.exe")
    await copyFile(binary, backup)
    await copyFile(node, binary)
    const child = spawn(binary, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { env, stdio: ["ignore", "pipe", "pipe"] })
    try {
      await once(child.stdout, "data")
      let executed = false
      await assert.rejects(installSharedOpenCode("2.0.11", { ...options,
        probe: async () => ({ valid: true, version: MINIMUM_OPENCODE_VERSION }),
        execute: async () => { executed = true },
      }), error => error.code === "installation_in_use")
      assert.equal(executed, false, "npm must not retire the live package")
      assert.equal(child.exitCode, null, "installation never stops a running executable")
    } finally {
      const closed = once(child, "close")
      child.kill()
      await closed
      await copyFile(backup, binary)
    }
    assert.match(execFileSync(binary, ["--version"], { encoding: "utf8", env }), new RegExp(MINIMUM_OPENCODE_VERSION.replaceAll(".", "\\.")))
    console.log("PASS: Windows live-executable update deferred before npm; original installation retained")
  }
  console.log(`PASS: shared user npm installation with isolated bundled Node, no system Node PATH; backend and terminal both resolve ${MINIMUM_OPENCODE_VERSION}`)
} finally { await rm(root, { recursive: true, force: true }) }
