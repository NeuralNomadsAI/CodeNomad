import assert from "node:assert/strict"
import test from "node:test"
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { upgradeSharedOpenCode } from "./native-upgrade"
import { installSharedOpenCode, npmExecutable, npmCommandDirectory } from "./shared-installation"

test("native upgrade scopes bundled npm and prefix and cleans its shim on success/failure", async () => {
  for (const platform of ["win32", "linux"] as const) for (const fail of [false, true]) {
    let shim = ""
    const env = { Path: "/original", NPM_CONFIG_PREFIX: "/wrong", NPM_CONFIG_REGISTRY: "https://wrong.invalid" }
    const pending = upgradeSharedOpenCode({ binary: "/verified/opencode.exe", version: "2.0.16", prefix: "/verified prefix",
      node: "/bundled node/node", npm: "/bundled npm/npm-cli.js", env, platform,
      execute: async (file, args, childEnv, execution) => {
        assert.equal(file, "/verified/opencode.exe")
        assert.deepEqual(args, ["upgrade", "2.0.16", "--method", "npm"])
        assert.equal(childEnv.npm_config_prefix, "/verified prefix")
        assert.equal(childEnv.npm_config_registry, "https://registry.npmjs.org")
        assert.equal(childEnv.NPM_CONFIG_PREFIX, undefined)
        assert.equal(childEnv.NPM_CONFIG_REGISTRY, undefined)
        assert.equal(childEnv.CODENOMAD_UPGRADE_NODE, "/bundled node/node")
        assert.equal(childEnv.CODENOMAD_UPGRADE_NPM, "/bundled npm/npm-cli.js")
        const directory = childEnv.Path!.split(platform === "win32" ? ";" : ":/bundled")[0]
        assert.equal(execution?.cwd, directory)
        assert.equal(execution?.timeout, 360_000)
        shim = path.join(directory, platform === "win32" ? "npm.cmd" : "npm")
        assert.match(await readFile(shim, "utf8"), /CODENOMAD_UPGRADE_NODE/)
        if (fail) throw new Error("native failure")
      },
    })
    if (fail) await assert.rejects(pending, /native failure/)
    else await pending
    await assert.rejects(access(shim), { code: "ENOENT" })
    assert.equal(env.NPM_CONFIG_PREFIX, "/wrong", "do not mutate the backend environment")
    assert.equal(env.Path, "/original")
  }
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
        assert.deepEqual(args, ["upgrade", "2.0.16", "--method", "npm"])
        throw new Error("native failure")
      },
    }
    await assert.rejects(installSharedOpenCode("2.0.16", options), /native failure/)
    assert.equal(calls, 1, "no npm fallback after a failed native mutation")
    assert.equal(registrations, 0)
    await assert.rejects(installSharedOpenCode("2.0.16", { ...options, execute: async () => {} }), /version verification failed/)
    await installSharedOpenCode("2.0.16", { ...options, execute: async () => { await writeFile(binary, "2.0.16") } })
    await installSharedOpenCode("2.0.15", options)
    assert.equal(calls, 1, "no downgrade or same-version native invocation")
    assert.equal(registrations, 2)
    assert.equal(await readFile(binary, "utf8"), "2.0.16")
  } finally { await rm(home, { recursive: true, force: true }) }
})
