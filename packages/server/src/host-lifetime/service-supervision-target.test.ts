import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile, rm, rename, realpath } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { test } from "node:test"
import { acquireSupervisionTarget, supervisionTargetReady } from "./service-supervision-target"

test("absolute targets with spaces pin bytes and npm package/installation provenance, with no fallback", async t => {
  const temp = path.join(os.tmpdir(), "opencode")
  await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(path.join(temp, "supervision binary ")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = path.join(root, "npm prefix", ...(process.platform === "win32" ? [] : ["lib"]), "node_modules/@opencode/cli/bin/opencode.exe")
  const packageFile = path.resolve(binary, "../../package.json")
  const lock = path.join(root, "npm prefix/.codenomad-opencode-install.lock")
  await mkdir(path.dirname(binary), { recursive: true })
  await writeFile(binary, "complete isolated executable bytes")
  await writeFile(packageFile, JSON.stringify({ name: "@opencode/cli", version: "99.0.0", bin: { opencode: "./bin/opencode.exe" } }))
  const target = await acquireSupervisionTarget(binary)
  assert.equal(target.provenance, "npm")
  assert.equal(target.package?.file, packageFile)
  assert.equal(target.package?.lock, lock)
  assert.equal(await supervisionTargetReady(target), true)
  await writeFile(lock, "installing")
  assert.equal(await supervisionTargetReady(target), false)
  await assert.rejects(acquireSupervisionTarget(binary), /busy/)
  await rm(lock)
  const hidden = `${binary}.hidden`
  await rename(binary, hidden)
  assert.equal(await supervisionTargetReady(target), false)
  await writeFile(binary, "partial")
  assert.equal(await supervisionTargetReady(target), false)
  await rm(binary); await rename(hidden, binary)
  const roots = { config: path.join(root, "config/opencode"), state: path.join(root, "state/opencode") }
  for (const value of Object.values(roots)) await mkdir(value, { recursive: true })
  await writeFile(path.join(roots.config, "service.json"), JSON.stringify({ password: "isolated-fixture" }))
  await writeFile(binary, "complete future compatible executable")
  const calls: string[][] = []
  const replacement = { namespace: { platform: process.platform === "win32" ? "win32" as const : "linux" as const,
    host: "fixture", user: "fixture", configDirectory: roots.config, stateDirectory: roots.state, registrationName: "service.json" },
    run: async (args: string[]) => {
      calls.push(args)
      return args[0] === "debug" ? roots[args[2] as keyof typeof roots] : "isolated-fixture"
    } }
  assert.equal(await supervisionTargetReady(target), false)
  assert.equal(await supervisionTargetReady(target, undefined, replacement), true)
  assert.deepEqual(calls, [["debug", "paths", "config"], ["debug", "paths", "state"], ["service", "get", "password"]])
  assert.equal(await supervisionTargetReady(target, undefined, { ...replacement,
    namespace: { ...replacement.namespace, registrationName: "service-beta.json" } }), false)
  await writeFile(path.join(roots.config, "service-beta.json"), JSON.stringify({ password: "isolated-fixture" }))
  assert.equal(await supervisionTargetReady(target, undefined, replacement), false, "ambiguous channels are refused")
  await writeFile(packageFile, JSON.stringify({ name: "foreign-package", bin: { opencode: "./bin/opencode.exe" } }))
  assert.equal(await supervisionTargetReady(target), false)
  await assert.rejects(acquireSupervisionTarget(binary), /invalid/)
  await assert.rejects(acquireSupervisionTarget("opencode"), /invalid/)
  assert.equal(await supervisionTargetReady({ binary, provenance: "custom" }), false)
})
