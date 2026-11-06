import assert from "node:assert/strict"
import test from "node:test"
import { access, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { InstallationInterruptedError, withInstallationLock } from "./installation-lock"
import { upgradeSharedOpenCode } from "./native-upgrade"
import { installSharedOpenCode, npmExecutable, npmCommandDirectory } from "./shared-installation"
import { MINIMUM_OPENCODE_VERSION as minimum } from "../opencode/runtime-support"

test("native upgrade scopes bundled npm and prefix in the prefix, cleans its shim, and retains it on interruption", async () => {
  // Electron's executable needs the scoped `node` command; Tauri's Node (also
  // started with ELECTRON_RUN_AS_NODE) is found by name beside npm.
  const root = await mkdtemp(path.join(os.tmpdir(), "native-upgrade-shim-"))
  const prefix = path.join(root, "verified prefix")
  await mkdir(prefix)
  try {
    for (const platform of ["win32", "linux"] as const) for (const electron of [true, false]) for (const outcome of ["success", "failure", "interrupted"]) {
      let shim = ""
      const node = electron ? "/application/CodeNomad" : platform === "win32" ? "/bundled node/node.exe" : "/bundled node/bin/node"
      const env = { Path: "/original", ELECTRON_RUN_AS_NODE: "1", NPM_CONFIG_PREFIX: "/wrong", NPM_CONFIG_REGISTRY: "https://wrong.invalid" }
      const pending = upgradeSharedOpenCode({ binary: "/verified/opencode.exe", version: "2.0.16", prefix,
        node, npm: "/bundled npm/npm-cli.js", env, platform,
        execute: async (file, args, childEnv, execution) => {
          assert.equal(file, "/verified/opencode.exe")
          assert.deepEqual(args, ["upgrade", "2.0.16", "--method", "npm"])
          assert.equal(childEnv.npm_config_prefix, prefix)
          assert.equal(childEnv.npm_config_registry, "https://registry.npmjs.org")
          assert.equal(childEnv.NPM_CONFIG_PREFIX, undefined)
          assert.equal(childEnv.NPM_CONFIG_REGISTRY, undefined)
          assert.equal(childEnv.CODENOMAD_UPGRADE_NODE, node)
          assert.equal(childEnv.CODENOMAD_UPGRADE_NPM, "/bundled npm/npm-cli.js")
          const separator = platform === "win32" ? ";" : ":"
          const runtime = separator + path.dirname(node) + separator
          assert.ok(childEnv.Path!.endsWith(runtime + "/original"))
          const directory = childEnv.Path!.slice(0, -(runtime + "/original").length)
          assert.equal(path.dirname(directory), prefix)
          assert.match(path.basename(directory), /^\.codenomad-upgrade-/)
          assert.equal(execution?.cwd, directory)
          assert.equal(execution?.timeout, 360_000)
          const command = path.join(directory, platform === "win32" ? "node.cmd" : "node")
          if (electron) {
            assert.equal(childEnv.CODENOMAD_NPM_NODE, node)
            assert.match(await readFile(command, "utf8"), /CODENOMAD_NPM_NODE/)
          } else {
            assert.equal(childEnv.CODENOMAD_NPM_NODE, undefined)
            await assert.rejects(access(command), { code: "ENOENT" })
          }
          shim = path.join(directory, platform === "win32" ? "npm.cmd" : "npm")
          assert.match(await readFile(shim, "utf8"), /CODENOMAD_UPGRADE_NODE/)
          if (outcome === "interrupted") throw new InstallationInterruptedError()
          if (outcome === "failure") throw new Error("native failure")
        },
      })
      if (outcome === "success") await pending
      else await assert.rejects(pending, outcome === "failure" ? /native failure/ : InstallationInterruptedError)
      if (outcome === "interrupted") {
        await access(shim)
        await rm(path.dirname(shim), { recursive: true, force: true })
      } else await assert.rejects(access(shim), { code: "ENOENT" })
      assert.deepEqual(await readdir(prefix), [])
      assert.equal(env.NPM_CONFIG_PREFIX, "/wrong", "do not mutate the backend environment")
      assert.equal(env.Path, "/original")
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a fresh installation lock removes installer directories retained by an interrupted installer", async () => {
  const prefix = await mkdtemp(path.join(os.tmpdir(), "installer-directory-recovery-"))
  try {
    for (const name of [".codenomad-npm-retained", ".codenomad-upgrade-retained"]) {
      await mkdir(path.join(prefix, name))
      await writeFile(path.join(prefix, name, "node"), "")
    }
    await mkdir(path.join(prefix, "node_modules"))
    await writeFile(path.join(prefix, ".codenomad-npm-file"), "not a directory")
    await withInstallationLock(prefix, async () => {
      assert.deepEqual((await readdir(prefix)).sort(), [".codenomad-npm-file", ".codenomad-opencode-install.lock", "node_modules"])
    })
  } finally { await rm(prefix, { recursive: true, force: true }) }
})

test("shared update delegates to native CLI, verifies publication, and never retries npm on failure", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-upgrade-test-"))
  const prefix = path.join(home, "npm prefix")
  const binary = npmExecutable(prefix)
  const directory = npmCommandDirectory(prefix)
  const command = path.join(directory, process.platform === "win32" ? "opencode2.cmd" : "opencode2")
  try {
    await mkdir(path.dirname(binary), { recursive: true })
    await mkdir(directory, { recursive: true })
    await writeFile(binary, "2.0.15", { mode: 0o755 })
    await writeFile(path.join(path.dirname(binary), "../package.json"), JSON.stringify({ name: "@opencode/cli", bin: { opencode2: "./bin/opencode.exe" } }))
    if (process.platform === "win32") await writeFile(command, '@echo off\r\n"%~dp0\\node_modules\\@opencode\\cli\\bin\\opencode.exe" %*\r\n')
    else await symlink(binary, command)
    let calls = 0, registrations = 0
    const options = { home, env: { PATH: directory }, npm: "fixture-npm.js",
      probe: async (file: string) => ({ valid: true, version: await readFile(file, "utf8") }),
      registerPath: async () => { registrations++ },
      execute: async (file: string, args: string[]) => {
        calls++
        assert.equal(file, binary)
        assert.deepEqual(args, ["upgrade", minimum, "--method", "npm"])
        throw new Error("native failure")
      },
    }
    await assert.rejects(installSharedOpenCode(minimum, options), /native failure/)
    assert.equal(calls, 1, "no npm fallback after a failed native mutation")
    assert.equal(registrations, 0)
    await assert.rejects(installSharedOpenCode(minimum, { ...options, execute: async () => {} }), /version verification failed/)
    await installSharedOpenCode(minimum, { ...options, execute: async () => { await writeFile(binary, minimum) } })
    await installSharedOpenCode(minimum, options)
    assert.equal(calls, 1, "no downgrade or same-version native invocation")
    assert.equal(registrations, 2)
    assert.equal(await readFile(binary, "utf8"), minimum)
    await writeFile(binary, "2.2.4")
    await installSharedOpenCode(minimum, options)
    assert.equal(await readFile(binary, "utf8"), "2.2.4", "never downgrade a newer verified installation")
    assert.equal(calls, 1)
  } finally { await rm(home, { recursive: true, force: true }) }
})
