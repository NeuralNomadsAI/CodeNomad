import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import {
  buildServiceLaunchSpec,
  buildWindowsSpawnSpec,
  parseWslUncPath,
  resolveWslHostDirectory,
  resolveWslServiceDirectory,
  resolveWslWorkingDirectory,
} from "../spawn"

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

describe("resolveWslServiceDirectory", () => {
  it("converts WSL UNC paths without invoking wslpath", () => {
    assert.equal(
      resolveWslServiceDirectory(String.raw`\\wsl.localhost\Ubuntu\home\dev\workspace`, "Ubuntu", () => {
        throw new Error("wslpath should not run")
      }),
      "/home/dev/workspace",
    )
  })

  it("uses wslpath for Windows workspace paths", () => {
    assert.equal(
      resolveWslServiceDirectory(String.raw`C:\Users\dev\workspace`, "Ubuntu", (folder, distro) => {
        assert.equal(folder, String.raw`C:\Users\dev\workspace`)
        assert.equal(distro, "Ubuntu")
        return "/mnt/c/Users/dev/workspace"
      }),
      "/mnt/c/Users/dev/workspace",
    )
  })

  it("bounds Windows path translation and returns null on timeout", () => {
    let timeoutMs = 0
    const startedAt = Date.now()
    assert.equal(
      resolveWslServiceDirectory(String.raw`C:\Users\dev\workspace`, "Ubuntu", (_folder, _distro, timeout) => {
        timeoutMs = timeout
        const result = spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout })
        assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT")
        return result.status === 0 ? result.stdout.toString() : undefined
      }, 25),
      null,
    )
    assert.equal(timeoutMs, 25)
    assert.ok(Date.now() - startedAt < 1_000)
  })

  it("maps service paths back to host paths with the same bound", () => {
    assert.equal(
      resolveWslHostDirectory("/mnt/c/Users/dev/workspace", "Ubuntu", (folder, distro, timeout) => {
        assert.deepEqual([folder, distro, timeout], ["/mnt/c/Users/dev/workspace", "Ubuntu", 23])
        return String.raw`C:\Users\dev\workspace`
      }, 23),
      String.raw`C:\Users\dev\workspace`,
    )
  })
})

describe("buildServiceLaunchSpec", () => {
  it("returns the configured host binary or discriminated WSL binary", () => {
    assert.deepEqual(
      buildServiceLaunchSpec("opencode.exe", { platform: "win32" }),
      { kind: "host", binary: "opencode.exe", platform: "win32" },
    )
    assert.deepEqual(
      buildServiceLaunchSpec("opencode.ps1", { platform: "win32" }),
      { kind: "host", binary: "opencode.ps1", platform: "win32" },
    )
    assert.deepEqual(
      buildServiceLaunchSpec(String.raw`\\wsl.localhost\Ubuntu\home\dev\opencode`, { platform: "win32" }),
      { kind: "wsl", distro: "Ubuntu", binary: "/home/dev/opencode" },
    )
  })

  it("never converts a WSL service binary into a host lifecycle", () => {
    const launch = buildServiceLaunchSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\opencode`,
      { platform: "win32" },
    )

    assert.deepEqual(launch, { kind: "wsl", distro: "Ubuntu", binary: "/home/dev/opencode" })
    assert.equal("binary" in launch, true)
  })
})

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
