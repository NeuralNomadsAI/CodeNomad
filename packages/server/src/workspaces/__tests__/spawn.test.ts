import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { buildWindowsSpawnSpec, parseWslUncPath, resolveWslWorkingDirectory } from "../spawn"

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

  it("wraps WSL binaries with wsl.exe and propagates required env vars", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve", "--port", "0"],
      {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\dev\workspace`,
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ["file:///C:/Users/dev/AppData/Roaming/CodeNomad/plugin.tgz"] }),
          CODENOMAD_INSTANCE_ID: "workspace-123",
          OPENCODE_SERVER_BASE_URL: "https://127.0.0.1:4321/workspaces/workspace-123/instance",
          OPENCODE_SERVER_PASSWORD: "secret",
        },
        propagateEnvKeys: ["OPENCODE_CONFIG_CONTENT", "CODENOMAD_INSTANCE_ID", "OPENCODE_SERVER_BASE_URL", "OPENCODE_SERVER_PASSWORD"],
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
    assert.equal(spec.env?.WSLENV, "OPENCODE_CONFIG_CONTENT:CODENOMAD_INSTANCE_ID:OPENCODE_SERVER_BASE_URL:OPENCODE_SERVER_PASSWORD")
  })

  it("preserves non-path OPENCODE_CONFIG_CONTENT WSLENV entries", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve"],
      {
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ["file:///C:/Users/dev/AppData/Roaming/CodeNomad/plugin.tgz"] }),
          WSLENV: "OPENCODE_CONFIG_CONTENT:CODENOMAD_INSTANCE_ID/u",
        },
        propagateEnvKeys: ["OPENCODE_CONFIG_CONTENT", "CODENOMAD_INSTANCE_ID"],
      },
    )

    assert.equal(spec.env?.WSLENV, "OPENCODE_CONFIG_CONTENT:CODENOMAD_INSTANCE_ID/u")
  })

  it("rewrites packaged plugin paths for WSL before launching", () => {
    const spec = buildWindowsSpawnSpec(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\.opencode\bin\opencode`,
      ["serve"],
      {
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            plugin: [
              "@codenomad/codenomad-opencode-plugin@file:C:/Users/dev/AppData/Roaming/CodeNomad/codenomad-opencode-plugin.tgz",
            ],
          }),
        },
        propagateEnvKeys: ["OPENCODE_CONFIG_CONTENT"],
      },
    )

    assert.equal(spec.command, "wsl.exe")
    assert.equal(spec.env?.CODENOMAD_OPENCODE_PLUGIN_WSL_PATH, String.raw`C:\Users\dev\AppData\Roaming\CodeNomad\codenomad-opencode-plugin.tgz`)
    assert.match(spec.env?.OPENCODE_CONFIG_CONTENT ?? "", /__CODENOMAD_OPENCODE_PLUGIN_WSL_PATH__/)
    assert.equal(spec.env?.WSLENV, "OPENCODE_CONFIG_CONTENT:CODENOMAD_OPENCODE_PLUGIN_WSL_PATH/p")
    assert.deepEqual(spec.args.slice(0, 4), ["--distribution", "Ubuntu", "--exec", "sh"])
    assert.match(spec.args[5] ?? "", /CODENOMAD_OPENCODE_PLUGIN_WSL_PATH/)
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
      `codenomad_pgid=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]'); codenomad_start=$(awk '{print $22}' "/proc/$$/stat" 2>/dev/null); codenomad_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null); test -n "$codenomad_pgid" && test -n "$codenomad_start" && test -n "$codenomad_boot" && printf '%s%s:%s:%s:%s\\n' '__CODENOMAD_WSL_PID__:' "$$" "$codenomad_pgid" "$codenomad_start" "$codenomad_boot" && cd "$1" && shift && exec "$@"`,
      "codenomad-wsl-launch",
      "/home/dev/workspace",
      "/home/dev/.opencode/bin/opencode",
      "serve",
    ])
    assert.equal(spec.wsl?.pidMarker, "__CODENOMAD_WSL_PID__:")
  })

})

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
