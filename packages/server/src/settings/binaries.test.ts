import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { ExecutionProfile } from "../api-types"
import { BinaryResolver } from "./binaries"

function createSettings(input?: {
  server?: Record<string, unknown>
  ui?: Record<string, unknown>
}) {
  return {
    getOwner(kind: "config" | "state", owner: string) {
      if (kind === "config" && owner === "server") {
        return input?.server ?? {}
      }
      if (kind === "state" && owner === "ui") {
        return input?.ui ?? {}
      }
      return {}
    },
  }
}

describe("BinaryResolver", () => {
  it("falls back to the configured default binary when no launch profile is selected", () => {
    const resolver = new BinaryResolver(
      createSettings({
        server: { opencodeBinary: "opencode-custom" },
        ui: { opencodeBinaries: [{ path: "opencode-custom", label: "Custom OpenCode", version: "1.2.3" }] },
      }) as any,
    )

    assert.deepEqual(resolver.resolveActive(), {
      kind: "local",
      path: "opencode-custom",
      label: "Custom OpenCode",
      version: "1.2.3",
    })
  })

  it("resolves an explicit local launch profile", () => {
    const profile: ExecutionProfile = {
      id: "local-default",
      name: "Local Default",
      kind: "local",
      binaryPath: "C:/Tools/opencode.exe",
    }

    const resolver = new BinaryResolver(
      createSettings({
        server: { executionProfiles: [profile] },
      }) as any,
    )

    assert.deepEqual(resolver.resolveActive(profile.id), {
      kind: "local",
      path: "C:/Tools/opencode.exe",
      label: "Local Default",
      executionProfileId: "local-default",
      executionProfileName: "Local Default",
      executionProfileKind: "local",
    })
  })

  it("resolves a default WSL launch profile from server config", () => {
    const profile: ExecutionProfile = {
      id: "wsl-ubuntu",
      name: "WSL Ubuntu",
      kind: "wsl",
      distro: "Ubuntu",
      binaryPath: String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
    }

    const resolver = new BinaryResolver(
      createSettings({
        server: {
          executionProfiles: [profile],
          defaultExecutionProfileId: profile.id,
          opencodeBinary: "opencode",
        },
      }) as any,
    )

    assert.deepEqual(resolver.resolveActive(), {
      kind: "wsl",
      path: String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      wslDistro: "Ubuntu",
      label: "WSL Ubuntu",
      executionProfileId: "wsl-ubuntu",
      executionProfileName: "WSL Ubuntu",
      executionProfileKind: "wsl",
    })
  })

  it("resolves a docker execution profile", () => {
    const profile: ExecutionProfile = {
      id: "docker-sandbox",
      name: "Docker Sandbox",
      kind: "docker",
      image: "ghcr.io/example/opencode:latest",
      workspaceMountPath: "/workspace",
      configMountPath: "/root/.config/opencode",
      command: ["opencode"],
      extraDockerArgs: ["--init"],
    }

    const resolver = new BinaryResolver(
      createSettings({
        server: { executionProfiles: [profile] },
      }) as any,
    )

    assert.deepEqual(resolver.resolveActive(profile.id), {
      kind: "docker",
      label: "Docker Sandbox",
      image: "ghcr.io/example/opencode:latest",
      workspaceMountPath: "/workspace",
      configMountPath: "/root/.config/opencode",
      command: ["opencode"],
      extraDockerArgs: ["--init"],
      executionProfileId: "docker-sandbox",
      executionProfileName: "Docker Sandbox",
      executionProfileKind: "docker",
    })
  })

  it("resolves a command execution profile", () => {
    const profile: ExecutionProfile = {
      id: "custom-wrapper",
      name: "Custom Wrapper",
      kind: "command",
      executable: "node",
      args: ["scripts/opencode-wrapper.mjs"],
      cwdMode: "inherit",
    }

    const resolver = new BinaryResolver(
      createSettings({
        server: { executionProfiles: [profile] },
      }) as any,
    )

    assert.deepEqual(resolver.resolveActive(profile.id), {
      kind: "command",
      label: "Custom Wrapper",
      executable: "node",
      args: ["scripts/opencode-wrapper.mjs"],
      cwdMode: "inherit",
      executionProfileId: "custom-wrapper",
      executionProfileName: "Custom Wrapper",
      executionProfileKind: "command",
    })
  })

  it("resolves an SSH execution profile", () => {
    const profile: ExecutionProfile = {
      id: "ssh-linux",
      name: "SSH Linux",
      kind: "ssh",
      host: "vm.example.com",
      port: 2222,
      username: "ubuntu",
      remotePath: "/srv/project",
      binaryPath: "opencode",
      args: ["--experimental"],
    }

    const resolver = new BinaryResolver(
      createSettings({
        server: { executionProfiles: [profile] },
      }) as any,
    )

    assert.deepEqual(resolver.resolveActive(profile.id), {
      kind: "ssh",
      label: "SSH Linux",
      host: "vm.example.com",
      port: 2222,
      username: "ubuntu",
      remotePath: "/srv/project",
      binaryPath: "opencode",
      args: ["--experimental"],
      executionProfileId: "ssh-linux",
      executionProfileName: "SSH Linux",
      executionProfileKind: "ssh",
    })
  })

  it("throws when an explicit execution profile id does not exist", () => {
    const resolver = new BinaryResolver(createSettings() as any)
    assert.throws(() => resolver.resolveActive("missing-profile"), /Execution profile not found/)
  })
})
