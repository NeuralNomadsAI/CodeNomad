import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { buildServiceLaunchSpec, buildWindowsSpawnSpec, parseWslUncPath, resolveWslWorkingDirectory } from "../spawn"

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
  it("classifies native executables separately from script and shell wrappers", () => {
    assert.equal(buildWindowsSpawnSpec("opencode.exe", []).processKind, "windows-direct")
    assert.equal(buildWindowsSpawnSpec("opencode.cmd", []).processKind, "windows-wrapper")
    assert.equal(buildWindowsSpawnSpec("powershell.exe", []).processKind, "windows-wrapper")
  })

  it("conservatively classifies bare commands as wrappers", () => {
    assert.equal(buildWindowsSpawnSpec("opencode", []).processKind, "windows-wrapper")
  })

  it("resolves a bare cmd shim from a quoted PATH entry and wraps its absolute path", { skip: process.platform !== "win32" }, () => {
    const root = mkdtempSync(path.join(tmpdir(), "codenomad-spawn-"))
    const cwd = path.join(root, "workspace")
    const bin = path.join(root, "bin with spaces")
    mkdirSync(cwd)
    mkdirSync(bin)
    const shim = path.join(bin, "opencode.cmd")
    writeFileSync(shim, "@echo off\r\n")

    try {
      const spec = buildWindowsSpawnSpec("opencode", ["serve"], {
        cwd,
        env: { Path: `"${bin}"`, PathExt: ".CMD;.EXE", ComSpec: "test-cmd.exe" },
      })

      assert.equal(spec.command, "test-cmd.exe")
      assert.equal(spec.processKind, "windows-wrapper")
      assert.equal(spec.options.windowsVerbatimArguments, true)
      assert.match(spec.args[3] ?? "", new RegExp(escapeRegex(path.win32.resolve(shim)), "i"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("honors PATHEXT precedence when both native and shim files exist", { skip: process.platform !== "win32" }, () => {
    const root = mkdtempSync(path.join(tmpdir(), "codenomad-spawn-"))
    writeFileSync(path.join(root, "opencode.cmd"), "@echo off\r\n")
    writeFileSync(path.join(root, "opencode.exe"), "")

    try {
      const spec = buildWindowsSpawnSpec("opencode", [], {
        cwd: root,
        env: { PATH: "", PATHEXT: ".EXE;.CMD" },
      })

      assert.equal(spec.command.toLowerCase(), path.win32.resolve(root, "opencode.exe").toLowerCase())
      assert.equal(spec.processKind, "windows-direct")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("leaves an unresolved bare command unchanged without injecting a shell", () => {
    const spec = buildWindowsSpawnSpec("missing-opencode", ["serve"], {
      cwd: String.raw`C:\missing-workspace`,
      env: { PATH: "", PATHEXT: ".CMD;.EXE", ComSpec: "must-not-run.exe" },
    })

    assert.equal(spec.command, "missing-opencode")
    assert.deepEqual(spec.args, ["serve"])
    assert.equal(spec.processKind, "windows-wrapper")
    assert.equal(spec.options.windowsVerbatimArguments, undefined)
  })

  it("wraps WSL binaries with wsl.exe", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve", "--port", "0"],
      {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\dev\workspace`,
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

  it("propagates requested configured variables into WSL", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve"],
      {
        env: { CUSTOM_SERVICE_VALUE: "configured" },
        propagateEnvKeys: ["CUSTOM_SERVICE_VALUE"],
      },
    )

    assert.equal(spec.env?.WSLENV, "CUSTOM_SERVICE_VALUE")
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

})

describe("buildServiceLaunchSpec", () => {
  it("returns direct commands for executables, PowerShell, and WSL", () => {
    assert.deepEqual(
      buildServiceLaunchSpec("opencode.exe", ["serve"], { platform: "win32" }).command,
      ["opencode.exe", "serve"],
    )
    assert.deepEqual(
      buildServiceLaunchSpec("opencode.ps1", ["serve"], { platform: "win32" }).command,
      ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "opencode.ps1", "serve"],
    )
    assert.equal(
      buildServiceLaunchSpec(String.raw`\\wsl.localhost\Ubuntu\home\dev\opencode`, ["serve"], { platform: "win32" }).command[0],
      "wsl.exe",
    )
  })

  it("uses a Node trampoline for the verbatim cmd.exe batch command", () => {
    const launch = buildServiceLaunchSpec(String.raw`C:\Program Files\OpenCode\opencode.cmd`, ["serve", "--service"], {
      platform: "win32",
      env: { ComSpec: "test-cmd.exe" },
    })

    assert.equal(launch.command[0], process.execPath)
    assert.equal(launch.command[1], "-e")
    assert.equal(launch.command[3], "test-cmd.exe")
    assert.deepEqual(JSON.parse(launch.command[4] ?? "[]"), [
      "/d", "/s", "/c", String.raw`""C:\Program Files\OpenCode\opencode.cmd" serve --service"`,
    ])
    assert.equal(launch.command[5], "")
  })

  it("records a direct service contender PID", () => {
    const launch = buildServiceLaunchSpec("opencode.exe", ["serve", "--service"], {
      platform: "win32",
      contenderFile: String.raw`C:\Temp\codenomad-contenders.txt`,
    })

    assert.equal(launch.command[0], process.execPath)
    assert.equal(launch.command[3], "opencode.exe")
    assert.equal(launch.command[5], String.raw`C:\Temp\codenomad-contenders.txt`)
    assert.equal(launch.command[6], "false")
  })

  it("translates shared Windows state and contender files for WSL", () => {
    const contenderFile = String.raw`C:\Temp\codenomad\contenders.txt`
    const launch = buildServiceLaunchSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\opencode`,
      ["serve", "--service"],
      {
        platform: "win32",
        contenderFile,
        env: { XDG_STATE_HOME: String.raw`C:\Temp\codenomad` },
      },
    )

    assert.equal(launch.command[0], "wsl.exe")
    assert.match(launch.command[6] ?? "", /wslpath -au/)
    assert.equal(launch.command[8], contenderFile)
    assert.equal(launch.env?.WSLENV, "XDG_STATE_HOME/p")
  })
})

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
