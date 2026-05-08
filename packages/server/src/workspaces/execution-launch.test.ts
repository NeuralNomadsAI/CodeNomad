import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { ResolvedBinary } from "../settings/binaries"
import { buildLaunchCommand, buildLaunchPreview, formatCommandLine } from "./execution-launch"

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

  it("formats preview command lines with quoting", () => {
    assert.equal(formatCommandLine("docker", ["run", "C:/Program Files/OpenCode/opencode.exe", "--flag"]), 'docker run "C:/Program Files/OpenCode/opencode.exe" --flag')
  })

  if (process.platform === "win32") {
    it("builds a WSL preview using the actual spawn command", () => {
      const execution: ResolvedBinary = {
        kind: "wsl",
        label: "Ubuntu",
        path: String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      }

      const result = buildLaunchPreview({
        execution,
        workspacePath: String.raw`D:\CodeNomad`,
        environment: {
          OPENCODE_CONFIG_DIR: String.raw`C:\Users\dev\AppData\Roaming\CodeNomad\opencode-config`,
          CODENOMAD_INSTANCE_ID: "preview-instance",
          OPENCODE_SERVER_BASE_URL: "https://127.0.0.1:9898/workspaces/preview-instance/worktrees/root/instance",
          OPENCODE_SERVER_PASSWORD: "REDACTED",
        },
        logLevel: "DEBUG",
      })

      assert.equal(result.command, "wsl.exe")
      assert.deepEqual(result.args.slice(0, 6), [
        "--distribution",
        "Ubuntu",
        "--exec",
        "sh",
        "-lc",
        'printf \'%s%s\\n\' \'__CODENOMAD_WSL_PID__:\' "$$" && cd "$(wslpath -au "$1")" && shift && exec "$@"',
      ])
      assert.equal(result.environment?.WSLENV, "OPENCODE_CONFIG_DIR/p:CODENOMAD_INSTANCE_ID:OPENCODE_SERVER_BASE_URL:OPENCODE_SERVER_PASSWORD")
    })
  }
})
