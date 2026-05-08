import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { ResolvedBinary } from "../settings/binaries"
import { buildLaunchCommand } from "./execution-launch"

describe("buildLaunchCommand", () => {
  it("builds a command execution profile launch", () => {
    const execution: ResolvedBinary = {
      kind: "command",
      label: "Wrapper",
      executable: "ssh",
      args: ["user@example.com"],
      cwdMode: "inherit",
    }

    const result = buildLaunchCommand({
      execution,
      workspacePath: "D:/CodeNomad",
      environment: { CODENOMAD_INSTANCE_ID: "abc123" },
      logLevel: "DEBUG",
    })

    assert.equal(result.command, "ssh")
    assert.deepEqual(result.args, ["user@example.com", "serve", "--port", "0", "--print-logs", "--log-level", "DEBUG"])
    assert.equal(result.cwd, undefined)
    assert.deepEqual(result.environment, { CODENOMAD_INSTANCE_ID: "abc123" })
  })

  it("builds a docker execution profile launch with rewritten paths and URLs", () => {
    const execution: ResolvedBinary = {
      kind: "docker",
      label: "Docker Sandbox",
      image: "ghcr.io/example/opencode:latest",
      workspaceMountPath: "/workspace",
      configMountPath: "/root/.config/opencode",
      command: ["opencode"],
      extraDockerArgs: ["--init"],
    }

    const result = buildLaunchCommand({
      execution,
      workspacePath: "D:/CodeNomad",
      environment: {
        OPENCODE_CONFIG_DIR: "C:/Users/Admin/.config/opencode",
        NODE_EXTRA_CA_CERTS: "C:/Users/Admin/.config/codenomad/certs.pem",
        CODENOMAD_BASE_URL: "https://127.0.0.1:9898",
        OPENCODE_SERVER_BASE_URL: "https://127.0.0.1:9898/workspaces/abc/worktrees/root/instance",
      },
      logLevel: "INFO",
    })

    assert.equal(result.command, "docker")
    assert.ok(result.args.includes("ghcr.io/example/opencode:latest"))
    assert.ok(result.args.includes("D:/CodeNomad:/workspace"))
    assert.ok(result.args.includes("C:/Users/Admin/.config/opencode:/root/.config/opencode"))
    assert.ok(result.args.includes("C:/Users/Admin/.config/codenomad/certs.pem:/tmp/codenomad-node-extra-ca.pem:ro"))
    assert.ok(result.args.includes("CODENOMAD_BASE_URL=https://host.docker.internal:9898"))
    assert.ok(result.args.includes("OPENCODE_CONFIG_DIR=/root/.config/opencode"))
    assert.ok(result.args.includes("NODE_EXTRA_CA_CERTS=/tmp/codenomad-node-extra-ca.pem"))
    assert.deepEqual(result.args.slice(-6), ["serve", "--port", "0", "--print-logs", "--log-level", "INFO"])
  })
})
