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
      label: "Custom OpenCode",
      version: "1.2.3",
      launcher: {
        transport: "host",
        command: "opencode-custom",
        cwdMode: "workspace",
      },
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
      label: "Local Default",
      executionProfileId: "local-default",
      executionProfileName: "Local Default",
      executionProfileKind: "local",
      launcher: {
        transport: "host",
        command: "C:/Tools/opencode.exe",
        cwdMode: "workspace",
      },
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
      label: "WSL Ubuntu",
      executionProfileId: "wsl-ubuntu",
      executionProfileName: "WSL Ubuntu",
      executionProfileKind: "wsl",
      launcher: {
        transport: "host",
        command: String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
        cwdMode: "workspace",
        wslDistro: "Ubuntu",
      },
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
      executionProfileId: "docker-sandbox",
      executionProfileName: "Docker Sandbox",
      executionProfileKind: "docker",
      launcher: {
        transport: "docker",
        image: "ghcr.io/example/opencode:latest",
        workspaceMountPath: "/workspace",
        configMountPath: "/root/.config/opencode",
        command: "opencode",
        extraDockerArgs: ["--init"],
      },
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
      executionProfileId: "custom-wrapper",
      executionProfileName: "Custom Wrapper",
      executionProfileKind: "command",
      launcher: {
        transport: "host",
        command: "node",
        args: ["scripts/opencode-wrapper.mjs"],
        cwdMode: "inherit",
      },
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
      executionProfileId: "ssh-linux",
      executionProfileName: "SSH Linux",
      executionProfileKind: "ssh",
      launcher: {
        transport: "ssh",
        host: "vm.example.com",
        port: 2222,
        username: "ubuntu",
        remotePath: "/srv/project",
        command: "opencode",
        args: ["--experimental"],
      },
    })
  })

  it("splits docker entry commands into generic launcher command plus base args", () => {
    const profile: ExecutionProfile = {
      id: "docker-custom-entrypoint",
      name: "Docker Custom Entrypoint",
      kind: "docker",
      image: "ghcr.io/example/opencode:latest",
      workspaceMountPath: "/workspace",
      configMountPath: "/root/.config/opencode",
      command: ["node", "/app/wrapper.mjs"],
    }

    const resolver = new BinaryResolver(
      createSettings({
        server: { executionProfiles: [profile] },
      }) as any,
    )

    assert.deepEqual(resolver.resolveActive(profile.id).launcher, {
      transport: "docker",
      image: "ghcr.io/example/opencode:latest",
      workspaceMountPath: "/workspace",
      configMountPath: "/root/.config/opencode",
      command: "node",
      args: ["/app/wrapper.mjs"],
    })
  })

  it("throws when an explicit execution profile id does not exist", () => {
    const resolver = new BinaryResolver(createSettings() as any)
    assert.throws(() => resolver.resolveActive("missing-profile"), /Execution profile not found/)
  })
})
