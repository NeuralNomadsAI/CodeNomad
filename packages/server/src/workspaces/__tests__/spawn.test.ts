import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildWindowsSpawnSpec, buildWslSignalSpec, parseWslUncPath, resolveWslWorkingDirectory } from "../spawn"

describe("parseWslUncPath", () => {
  it("parses WSL UNC paths into distro and linux path", () => {
    assert.deepEqual(parseWslUncPath(String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`), {
      distro: "Ubuntu",
      linuxPath: "/home/dev/.opencode/bin/opencode",
    })
  })

  it("supports the legacy wsl$ UNC prefix", () => {
    assert.deepEqual(parseWslUncPath(String.raw`\\wsl$\Ubuntu\home\dev`), {
      distro: "Ubuntu",
      linuxPath: "/home/dev",
    })
  })
})

describe("resolveWslWorkingDirectory", () => {
  it("keeps WSL workspace folders in the same distro", () => {
    assert.equal(
      JSON.stringify(resolveWslWorkingDirectory(String.raw`\\wsl.localhost\Ubuntu\home\dev\workspace`, "Ubuntu")),
      JSON.stringify({ kind: "linux", path: "/home/dev/workspace" }),
    )
  })

  it("keeps Windows drive paths so WSL can resolve them with wslpath", () => {
    assert.equal(
      JSON.stringify(resolveWslWorkingDirectory(String.raw`C:\Users\dev\workspace`, "Ubuntu")),
      JSON.stringify({ kind: "windows", path: String.raw`C:\Users\dev\workspace` }),
    )
  })

  it("keeps UNC network paths so WSL can resolve them with wslpath", () => {
    assert.equal(
      JSON.stringify(resolveWslWorkingDirectory(String.raw`\\server\share\workspace`, "Ubuntu")),
      JSON.stringify({ kind: "windows", path: String.raw`\\server\share\workspace` }),
    )
  })

  it("rejects WSL workspace folders from a different distro", () => {
    assert.equal(resolveWslWorkingDirectory(String.raw`\\wsl.localhost\Debian\home\dev\workspace`, "Ubuntu"), null)
  })
})

describe("buildWindowsSpawnSpec", () => {
  it("wraps WSL binaries with wsl.exe and propagates required env vars", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve", "--port", "0"],
      {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\dev\workspace`,
        env: {
          OPENCODE_CONFIG_DIR: String.raw`C:\Users\dev\AppData\Roaming\CodeNomad\opencode-config`,
          CODENOMAD_INSTANCE_ID: "workspace-123",
          OPENCODE_SERVER_PASSWORD: "secret",
        },
        propagateEnvKeys: ["OPENCODE_CONFIG_DIR", "CODENOMAD_INSTANCE_ID", "OPENCODE_SERVER_PASSWORD"],
      },
    )

    assert.equal(spec.command, "wsl.exe")
    assert.deepEqual(spec.args, [
      "--distribution",
      "Ubuntu",
      "--cd",
      "/home/dev/workspace",
      "--exec",
      "/home/dev/.opencode/bin/opencode",
      "serve",
      "--port",
      "0",
    ])
    assert.equal(spec.cwd, undefined)
    assert.equal(spec.env?.WSLENV, "OPENCODE_CONFIG_DIR/p:CODENOMAD_INSTANCE_ID:OPENCODE_SERVER_PASSWORD")
  })

  it("upgrades existing WSLENV path entries to include /p", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve"],
      {
        env: {
          OPENCODE_CONFIG_DIR: String.raw`C:\Users\dev\AppData\Roaming\CodeNomad\opencode-config`,
          WSLENV: "OPENCODE_CONFIG_DIR:CODENOMAD_INSTANCE_ID/u",
        },
        propagateEnvKeys: ["OPENCODE_CONFIG_DIR", "CODENOMAD_INSTANCE_ID"],
      },
    )

    assert.equal(spec.env?.WSLENV, "OPENCODE_CONFIG_DIR/p:CODENOMAD_INSTANCE_ID/u")
  })

  it("propagates inherited known path variables even when they are not explicitly requested", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve"],
      {
        env: {
          NODE_EXTRA_CA_CERTS: String.raw`C:\certs\root.pem`,
        },
      },
    )

    assert.equal(spec.env?.WSLENV, "NODE_EXTRA_CA_CERTS/p")
  })

  it("uses wslpath for Windows workspace folders instead of assuming /mnt", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve", "--port", "0"],
      {
        cwd: String.raw`C:\Users\dev\workspace`,
      },
    )

    assert.equal(spec.command, "wsl.exe")
    assert.deepEqual(spec.args, [
      "--distribution",
      "Ubuntu",
      "--exec",
      "sh",
      "-lc",
      'cd "$(wslpath -au "$1")" && shift && exec "$@"',
      "codenomad-wsl-launch",
      String.raw`C:\Users\dev\workspace`,
      "/home/dev/.opencode/bin/opencode",
      "serve",
      "--port",
      "0",
    ])
  })

  it("uses wslpath for UNC network workspace folders", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve"],
      {
        cwd: String.raw`\\server\share\workspace`,
      },
    )

    assert.equal(spec.command, "wsl.exe")
    assert.deepEqual(spec.args, [
      "--distribution",
      "Ubuntu",
      "--exec",
      "sh",
      "-lc",
      'cd "$(wslpath -au "$1")" && shift && exec "$@"',
      "codenomad-wsl-launch",
      String.raw`\\server\share\workspace`,
      "/home/dev/.opencode/bin/opencode",
      "serve",
    ])
  })

  it("can wrap WSL launches to emit the Linux PID marker", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve"],
      {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\dev\workspace`,
        wslPidMarker: "__CODENOMAD_WSL_PID__:",
      },
    )

    assert.equal(spec.command, "wsl.exe")
    assert.deepEqual(spec.args, [
      "--distribution",
      "Ubuntu",
      "--exec",
      "sh",
      "-lc",
      `printf '%s%s\\n' '__CODENOMAD_WSL_PID__:' "$$" && cd "$1" && shift && exec "$@"`,
      "codenomad-wsl-launch",
      "/home/dev/workspace",
      "/home/dev/.opencode/bin/opencode",
      "serve",
    ])
    assert.equal(spec.wsl?.pidMarker, "__CODENOMAD_WSL_PID__:")
  })

  it("builds the WSL kill command for tracked Linux PIDs", () => {
    const spec = buildWslSignalSpec("Ubuntu", 4321, "SIGTERM")

    assert.equal(spec.command, "wsl.exe")
    assert.deepEqual(spec.args, ["--distribution", "Ubuntu", "--exec", "kill", "-TERM", "4321"])
  })
})
