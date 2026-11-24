import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BinaryResolver } from "../settings/binaries"
import type { SettingsService } from "../settings/service"
import { buildServiceLaunchSpec, buildSpawnSpec, probeOpenCodeBinary } from "../workspaces/spawn"
import { resolveDefaultInstallation, sharedInstallPrefix, userNpmPrefix } from "./shared-installation"

test("private executables are rejected before validation or launch, including an explicit selection", async () => {
  const binary = path.join(os.homedir(), ".local/share/codenomad/opencode/2.0.15/node_modules/@opencode/cli/bin/opencode.exe")
  let executed = false
  const validation = await probeOpenCodeBinary(binary, async () => { executed = true; return { status: 0, stdout: "opencode v2.0.15" } })
  assert.equal(validation.valid, false)
  assert.equal(executed, false)
  assert.throws(() => buildSpawnSpec(binary, ["service", "start"]), /opencode_private_installation_retired/)
  assert.throws(() => buildServiceLaunchSpec(binary), /opencode_private_installation_retired/)
  const settings = { getOwner: (scope: string) => scope === "config"
    ? { opencodeBinary: binary } : { opencodeBinaries: [{ path: binary }, { path: "custom" }] } } as unknown as SettingsService
  const resolver = new BinaryResolver(settings, () => ({ path: "opencode2" }))
  assert.equal(resolver.resolveDefault().path, "opencode2")
  assert.deepEqual(resolver.list(), [{ path: "custom" }])
})

test("private PATH entries cannot be launched or selected as a shared install prefix", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "retired-opencode-"))
  try {
    const directory = path.join(home, ".local/share/codenomad/opencode/2.0.15/bin")
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, process.platform === "win32" ? "opencode2.exe" : "opencode2"), "retired", { mode: 0o755 })
    const host = { home, env: { PATH: directory, APPDATA: path.join(home, "AppData") } }
    assert.deepEqual(resolveDefaultInstallation(host), { path: "opencode2" })
    assert.equal(sharedInstallPrefix(host), userNpmPrefix(host))
    assert.throws(() => buildSpawnSpec("opencode2", ["service", "start"], { env: host.env }), /opencode_private_installation_retired/)
    assert.equal(sharedInstallPrefix({ ...host, env: { ...host.env, npm_config_prefix: directory } }), undefined)
  } finally { await rm(home, { recursive: true, force: true }) }
})
