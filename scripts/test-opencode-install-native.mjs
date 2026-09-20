// Downloads only into a fresh fixture. No global npm install or shared daemon.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, cp, copyFile, chmod, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { tsImport } from "tsx/esm/api"
const { bundledNpm, installManagedOpenCode, readManagedExecutable } = await tsImport("../packages/server/src/opencode-update/managed-installation.ts", import.meta.url)
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
Object.assign(env, { HOME: root, USERPROFILE: root, LOCALAPPDATA: root,
  npm_config_cache: path.join(root, "npm-cache"), npm_config_userconfig: path.join(root, "npmrc"),
  PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "" })
try {
  const binary = await installManagedOpenCode(MINIMUM_OPENCODE_VERSION, { root: path.join(root, "install"), node, env })
  assert.equal(readManagedExecutable(path.join(root, "install")), binary)
  assert.match(execFileSync(binary, ["--version"], { encoding: "utf8", env }), new RegExp(MINIMUM_OPENCODE_VERSION.replaceAll(".", "\\.")))
  console.log(`PASS: native npm installation with isolated bundled Node, no system Node PATH, verified executable (${MINIMUM_OPENCODE_VERSION})`)
} finally { await rm(root, { recursive: true, force: true }) }
