import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { resolveDesktopPluginPaths } from "./desktop-plugin-paths"
import type { WslPathExecutor } from "./desktop-plugin-wsl-paths"

function connection(entries: unknown, assertCurrent = () => {}) {
  return {
    client: { config: { get: async () => entries } },
    assertCurrent,
  } as unknown as ServiceConnection
}

test("uses the connected host's first discovery directory, not a document or project source", async () => {
  const paths = await resolveDesktopPluginPaths(connection([
    { type: "document", path: "C:\\other\\opencode.json", info: {} },
    { type: "directory", path: "C:\\daemon config" },
    { type: "directory", path: "C:\\project\\.opencode" },
  ]), { kind: "host", platform: "win32", binary: "C:\\opencode.exe" })
  assert.equal(paths.config, "C:\\daemon config")
  assert.equal(path.win32.dirname(paths.data), "C:\\.codenomad")
  assert.match(path.win32.basename(paths.data), /^[a-f\d]{64}$/)
  const other = await resolveDesktopPluginPaths(connection([{ type: "directory", path: "C:\\other config" }]),
    { kind: "host", platform: "win32", binary: "C:\\opencode.exe" })
  assert.notEqual(paths.data, other.data, "Discovery roots must not share backend presence")
  const alias = await resolveDesktopPluginPaths(connection([{ type: "directory", path: "c:\\DAEMON CONFIG" }]),
    { kind: "host", platform: "win32", binary: "C:\\opencode.exe" })
  assert.equal(paths.data.toLowerCase(), alias.data.toLowerCase())
})

test("WSL resolves the connected daemon root into its selected distro, without a shell environment", async () => {
  const calls: unknown[] = []
  const execute: WslPathExecutor = async (distro, command, args, timeout) => {
    calls.push({ distro, command, args })
    assert.ok(timeout > 0 && timeout <= 15_000)
    const directory = args.at(-1)!
    return command === "realpath" ? `${directory}\n` : `\\\\wsl.localhost\\${distro}${directory.replaceAll("/", "\\")}\n`
  }
  const paths = await resolveDesktopPluginPaths(connection([
    { type: "directory", path: "/srv/existing daemon/config" },
    { type: "directory", path: "/home/new-user/project/.opencode" },
  ]), { kind: "wsl", distro: "Ubuntu-24.04", binary: "/usr/bin/opencode" }, Date.now() + 15_000, execute)
  assert.equal(paths.config, "\\\\wsl.localhost\\Ubuntu-24.04\\srv\\existing daemon\\config")
  assert.equal(path.posix.dirname(paths.nativeData!), "/srv/existing daemon/.codenomad")
  assert.equal(paths.data, `\\\\wsl.localhost\\Ubuntu-24.04${paths.nativeData!.replaceAll("/", "\\")}`)
  assert.deepEqual(calls.slice(0, 2), [
    { distro: "Ubuntu-24.04", command: "realpath", args: ["-m", "--", "/srv/existing daemon/config"] },
    { distro: "Ubuntu-24.04", command: "wslpath", args: ["-aw", "/srv/existing daemon/config"] },
  ])
})

test("WSL aliases and mounted roots share canonical storage and use actual mount translation", async () => {
  const launch = { kind: "wsl", distro: "Ubuntu", binary: "/bin/opencode" } as const
  const execute: WslPathExecutor = async (_distro, command, args) => {
    const directory = args.at(-1)!.replace("/home/test/config-alias", "/windows-drive/settings")
    return command === "realpath" ? `${directory}\n` : `${directory.replace("/windows-drive", "Q:").replaceAll("/", "\\")}\n`
  }
  const resolve = (directory: string) => resolveDesktopPluginPaths(connection([{ type: "directory", path: directory }]), launch, Date.now() + 15_000, execute)
  const alias = await resolve("/home/test/config-alias"), mounted = await resolve("/windows-drive/settings")
  assert.equal(alias.config, "Q:\\settings")
  assert.equal(alias.data, mounted.data)
  assert.equal(alias.nativeData, mounted.nativeData)
  assert.equal(path.posix.dirname(alias.nativeData!), "/windows-drive/.codenomad")
})

test("WSL translation is fenced after each async command", async () => {
  const launch = { kind: "wsl", distro: "Ubuntu", binary: "/bin/opencode" } as const
  for (const staleAt of [1, 2, 3, 4]) {
    let calls = 0, current = true
    const execute: WslPathExecutor = async (_distro, command, args) => {
      if (++calls === staleAt) current = false
      return command === "realpath" ? args.at(-1)! : "C:\\fixture"
    }
    await assert.rejects(resolveDesktopPluginPaths(connection([{ type: "directory", path: "/config" }], () => {
      if (!current) throw new Error("superseded")
    }), launch, Date.now() + 15_000, execute), /superseded/)
    assert.equal(calls, staleAt)
  }
  let calls = 0
  await assert.rejects(resolveDesktopPluginPaths(connection([{ type: "directory", path: "/config" }]), launch, Date.now() - 1, async () => {
    calls++; return "/config"
  }), /timed out/)
  assert.equal(calls, 0)
})

test("WSL canonicalization and translation share the original deadline", async (t) => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const timeouts: number[] = []
  await assert.rejects(resolveDesktopPluginPaths(connection([{ type: "directory", path: "/config" }]),
    { kind: "wsl", distro: "Ubuntu", binary: "/bin/opencode" }, now + 100,
    async (_distro, command, args, timeout) => {
      timeouts.push(timeout)
      now += 30
      return command === "realpath" ? args.at(-1)! : "C:\\config"
    }), /timed out/)
  assert.deepEqual(timeouts, [100, 70, 40, 10])
})

test("WSL rejects malformed translation output and canonical storage inside config", async () => {
  const launch = { kind: "wsl", distro: "Ubuntu", binary: "/bin/opencode" } as const
  for (const output of ["relative", "/config\n/other", "/bad\u0000path", "//ambiguous", "/back\\slash"]) {
    await assert.rejects(resolveDesktopPluginPaths(connection([{ type: "directory", path: "/config" }]), launch,
      Date.now() + 15_000, async () => output), /Invalid/)
  }
  for (const output of ["C:relative", "\\root-relative", "\\\\?\\C:\\device", "C:\\path\nC:\\second", "C:\\trailing ", "C:\\dir.\\config", "C:\\file:stream"]) {
    await assert.rejects(resolveDesktopPluginPaths(connection([{ type: "directory", path: "/config" }]), launch,
      Date.now() + 15_000, async (_distro, command) => command === "realpath" ? "/config" : output), /Invalid/)
  }
  await assert.rejects(resolveDesktopPluginPaths(connection([{ type: "directory", path: "/config" }]), launch,
    Date.now() + 15_000, async (_distro, command) => command === "realpath" ? "/config" : "\\\\wsl.localhost\\Other\\config"), /another distro/)
  await assert.rejects(resolveDesktopPluginPaths(connection([{ type: "directory", path: "/config" }]), launch,
    Date.now() + 15_000, async (_distro, command, args) => command === "wslpath" ? "C:\\config"
      : args.at(-1)!.includes(".codenomad") ? "/config/storage" : "/config"), /outside the discovery root/)
})

test("POSIX hosts preserve daemon-native paths", async () => {
  const paths = await resolveDesktopPluginPaths(connection([
    { type: "directory", path: "/srv/existing/config" },
  ]), { kind: "host", platform: "linux", binary: "/usr/bin/opencode" })
  assert.equal(paths.config, "/srv/existing/config")
  assert.equal(path.posix.dirname(paths.data), "/srv/existing/.codenomad")
})

test("fails explicitly without authoritative roots and fences stale discovery responses", async () => {
  const launch = { kind: "wsl", distro: "Ubuntu", binary: "/bin/opencode" } as const
  for (const entries of [undefined, {}, [], [{ type: "document", path: "/other/opencode.json" }],
    [{ type: "directory", path: "relative" }], [{ type: "directory", path: "C:\\host" }]]) {
    await assert.rejects(resolveDesktopPluginPaths(connection(entries), launch), /did not report an absolute/)
  }
  await assert.rejects(resolveDesktopPluginPaths(connection([
    { type: "directory", path: "/old/config" },
  ], () => { throw new Error("connection changed") }), launch), /connection changed/)
  await assert.rejects(resolveDesktopPluginPaths(connection([{ type: "directory", path: "/" }]), launch), /unwatched parent/)
})
