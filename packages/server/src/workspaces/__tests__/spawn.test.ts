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

  it("resolves an installed bare npm command to its packaged executable", () => {
    assert.equal(buildWindowsSpawnSpec("opencode2", []).processKind, "windows-direct")
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

  it("passes through a non-npm cmd wrapper with its required verbatim arguments", () => {
    const launch = buildServiceLaunchSpec(String.raw`C:\Program Files\OpenCode\opencode.cmd`, ["serve", "--service"], {
      platform: "win32",
      env: { ComSpec: "test-cmd.exe" },
    })

    assert.equal(launch.command[0], "test-cmd.exe")
    assert.deepEqual(launch.command.slice(1), [
      "/d", "/s", "/c", String.raw`""C:\Program Files\OpenCode\opencode.cmd" serve --service"`,
    ])
    assert.equal(launch.windowsVerbatimArguments, true)
    assert.equal(launch.nativePid, false)
    assert.equal(buildServiceLaunchSpec("custom.bat", ["serve"], { platform: "win32" }).nativePid, false)
    assert.equal(buildServiceLaunchSpec("custom.ps1", ["serve"], { platform: "win32" }).nativePid, false)
  })

  it("launches a direct service executable without a wrapper", () => {
    const launch = buildServiceLaunchSpec("opencode.exe", ["serve", "--service"], {
      platform: "win32",
      contenderFile: String.raw`C:\Temp\codenomad-contenders.txt`,
    })

    assert.equal(launch.command[0], process.execPath)
    assert.equal(launch.command[3], "opencode.exe")
    assert.deepEqual(JSON.parse(launch.command[4] ?? "[]"), ["serve", "--service"])
    assert.equal(launch.command[5], String.raw`C:\Temp\codenomad-contenders.txt`)
    assert.equal(launch.nativePid, true)
    assert.equal(launch.launcherRecordsPid, true)
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
    const wslArgs = launch.command.slice(1)
    assert.match(wslArgs[5] ?? "", /wslpath -au/)
    assert.equal(wslArgs[7], contenderFile)
    assert.equal(launch.env?.WSLENV, "XDG_STATE_HOME/p")
    assert.equal(launch.nativePid, false)
    assert.equal(launch.wslDistro, "Ubuntu")
  })

  it("passes configured service variables only to the launched child", () => {
    const launch = buildServiceLaunchSpec("opencode", ["serve", "--service"], {
      platform: "linux",
      env: { ...process.env, XDG_STATE_HOME: "/private/state", SERVICE_ONLY: "yes" },
      propagateEnvKeys: ["XDG_STATE_HOME", "SERVICE_ONLY"],
    })

    assert.deepEqual(launch.command, ["opencode", "serve", "--service"])
    assert.equal(launch.env?.XDG_STATE_HOME, "/private/state")
    assert.equal(launch.env?.SERVICE_ONLY, "yes")
  })

  it("resolves the standard Windows npm opencode2 shim to its packaged executable", { skip: process.platform !== "win32" }, () => {
    const root = mkdtempSync(path.join(tmpdir(), "codenomad-npm-shim-"))
    const executable = path.join(root, "node_modules", "@opencode-ai", "cli", "bin", "opencode2.exe")
    mkdirSync(path.dirname(executable), { recursive: true })
    writeFileSync(executable, "")
    writeFileSync(path.join(root, "opencode2.cmd"), '@ECHO off\r\n"%~dp0\\node_modules\\@opencode-ai\\cli\\bin\\opencode2.exe" %*\r\n')
    try {
      const launch = buildServiceLaunchSpec("opencode2", ["serve", "--service"], {
        platform: "win32",
        cwd: root,
        env: { PATH: root, PATHEXT: ".CMD" },
        contenderFile: path.join(root, "contenders.txt"),
      })
      assert.equal(launch.command[0], process.execPath)
      assert.equal(launch.command[3]?.toLowerCase(), executable.toLowerCase())
      assert.equal(launch.nativePid, true)
      assert.equal(launch.launcherRecordsPid, true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
