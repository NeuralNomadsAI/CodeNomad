import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { WorkspaceManager } from "../../workspaces/manager"
import { canonicalScope } from "../../host-lifetime/protocol"
import { resolveConfigLocation } from "../../config/location"
import { readAutonomousMissionEnvironment } from "../../opencode/missions/autonomous-environment"
import { physical } from "./private-files"
import { resolveStandingProfileSource } from "./profile-source"

test("explicit Play pins the selected custom YAML and exact WSL distro, never a caller path or default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-profile-source-"))
  try {
    const yaml = path.join(root, "selected custom.yml")
    await writeFile(yaml, "server: {}\n")
    const descriptor = { scope: canonicalScope("stable", yaml, root, root), physicalProfile: physical(await realpath(root)), executionHost: "wsl:Ubuntu-24.04" }
    const binding = { profileID: descriptor.scope.key, executionHost: descriptor.executionHost, projectID: "owned-project",
      projectCanonical: "/owned/project", roots: [{ mode: "directory-only" as const, directory: "/owned/project" }] }
    let distro: string | undefined = "Ubuntu-24.04", current = true, calls = 0
    const manager = { getServiceWslDistro: () => distro, getServicePathStyle: () => "posix" } as unknown as Pick<WorkspaceManager, "getServiceWslDistro" | "getServicePathStyle">
    let rootOwned = true
    const roots = { assertRoots: async (items: readonly { directory: string }[]) => {
      assert.equal(items[0]?.directory, "/owned/project")
      if (!rootOwned) throw new Error("physical family claim lost")
    } }
    const settings = { configYamlPathForAuthority: () => yaml }
    const input = { settings, descriptor, binding, manager, roots, workspaceID: "owned",
      assertCurrent: (): true => { if (!current) throw new Error("owned project changed"); return true } }
    const translate = async (source: string, selected: string) => {
      calls++
      assert.equal(source, yaml)
      assert.equal(selected, "Ubuntu-24.04")
      return "/mnt/selected/config/selected custom.yml"
    }
    const verifyNative = async (file: string, selected: string) => {
      assert.equal(file, "/mnt/selected/config/selected custom.yml")
      assert.equal(selected, "Ubuntu-24.04")
    }
    assert.deepEqual(await resolveStandingProfileSource(input, translate, verifyNative), {
      profileID: binding.profileID, executionHost: binding.executionHost, configYamlPath: "/mnt/selected/config/selected custom.yml",
    })
    assert.equal(calls, 1)
    await assert.rejects(resolveStandingProfileSource({ ...input, settings: { ...settings, configYamlPathForAuthority: () => path.join(root, "other.yml") } }, translate, verifyNative))
    assert.equal(calls, 1)
    await assert.rejects(resolveStandingProfileSource({ ...input, binding: { ...binding, profileID: "other" } }, translate, verifyNative))
    await assert.rejects(resolveStandingProfileSource(input, async () => "/wrong\npath", verifyNative))
    await unlink(yaml)
    await assert.rejects(resolveStandingProfileSource(input, translate, verifyNative), /observation-unavailable/)
    assert.equal(calls, 1, "missing custom YAML must be rejected before translation")
    await writeFile(yaml, "server: {}\n")
    distro = "Other"
    await assert.rejects(resolveStandingProfileSource(input, translate, verifyNative), /observation-unavailable/)
    assert.equal(calls, 1, "wrong distro must be rejected before translating")
    distro = "Ubuntu-24.04"
    await assert.rejects(resolveStandingProfileSource(input, async () => { distro = "Other"; return "/mnt/selected/config/selected custom.yml" }, verifyNative))
    distro = "Ubuntu-24.04"
    await assert.rejects(resolveStandingProfileSource(input, async () => { current = false; return "/mnt/selected/config/selected custom.yml" }, verifyNative))
    current = true
    await assert.rejects(resolveStandingProfileSource(input, async () => { rootOwned = false; return "/mnt/selected/config/selected custom.yml" }, verifyNative))
    rootOwned = true
    await assert.rejects(resolveStandingProfileSource(input, translate, async () => { throw new Error("WSL cannot read YAML") }), /WSL cannot read YAML/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("host source uses the exact selected YAML without a WSL converter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-host-profile-"))
  try {
    const yaml = path.join(root, "custom.yaml"), descriptor = {
      scope: canonicalScope("stable", yaml, root, root), physicalProfile: physical(await realpath(root)), executionHost: "host",
    }
    const input = { settings: { configYamlPathForAuthority: () => yaml }, descriptor,
      binding: { profileID: descriptor.scope.key, executionHost: "host", projectID: "owned", projectCanonical: root,
        roots: [{ mode: "directory-only" as const, directory: root }] },
      roots: { assertRoots: async () => {} },
      manager: { getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix" } as Pick<WorkspaceManager, "getServiceWslDistro" | "getServicePathStyle">,
      workspaceID: "owned", assertCurrent: (): true => true,
    }
    await assert.rejects(resolveStandingProfileSource(input), /observation-unavailable/, "missing YAML must not sign a silent empty environment")
    await writeFile(yaml, "server: {}\n")
    await assert.rejects(resolveStandingProfileSource({ ...input, descriptor: { ...descriptor, executionHost: "wsl:Other" },
      binding: { ...input.binding, executionHost: "wsl:Other" } }), /observation-unavailable/, "a WSL descriptor cannot sign a host source")
    const source = await resolveStandingProfileSource(input, async () => assert.fail("host path must not invoke WSL"))
    assert.equal(source.configYamlPath, yaml)
    await writeFile(yaml, "server:\n  environmentVariables:\n    SOURCE_MARKER: first\n")
    const scope = { profileID: source.profileID, executionHost: source.executionHost }
    const signal = new AbortController().signal, environment = { HOME: "/native/home" }
    assert.deepEqual(await readAutonomousMissionEnvironment(scope, source, signal, { environment, platform: "linux" }),
      { HOME: "/native/home", SOURCE_MARKER: "first" })
    await writeFile(yaml, "server:\n  environmentVariables:\n    SOURCE_MARKER: changed\n")
    assert.equal((await readAutonomousMissionEnvironment(scope, source, signal, { environment, platform: "linux" })).SOURCE_MARKER, "changed")
    await unlink(yaml)
    await assert.rejects(readAutonomousMissionEnvironment(scope, source, signal, { environment, platform: "linux" }),
      /Profile environment is unavailable/, "vanished YAML must not become an empty environment at due time")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("fresh default without config.yaml cannot enable recurring Play", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-missing-default-"))
  try {
    t.mock.method(os, "homedir", () => root)
    const yaml = resolveConfigLocation("").configYamlPath
    const descriptor = { scope: canonicalScope("stable", yaml, root, root), physicalProfile: root, executionHost: "host" }
    const binding = { profileID: descriptor.scope.key, executionHost: "host", projectID: "owned", projectCanonical: root,
      roots: [{ mode: "directory-only" as const, directory: root }] }
    const input = { settings: { configYamlPathForAuthority: () => yaml }, descriptor, binding, roots: { assertRoots: async () => {} }, workspaceID: "owned",
      manager: { getServiceWslDistro: () => undefined, getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix" } as Pick<WorkspaceManager, "getServiceWslDistro" | "getServicePathStyle">,
      assertCurrent: (): true => true }
    await assert.rejects(resolveStandingProfileSource(input), "missing default is not implicit ENV permission")
  } finally { await rm(root, { recursive: true, force: true }) }
})
