import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { resolveDesktopPluginPaths } from "./desktop-plugin-paths"

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
  const paths = await resolveDesktopPluginPaths(connection([
    { type: "directory", path: "/srv/existing daemon/config" },
    { type: "directory", path: "/home/new-user/project/.opencode" },
  ]), { kind: "wsl", distro: "Ubuntu-24.04", binary: "/usr/bin/opencode" })
  assert.equal(paths.config, "\\\\wsl.localhost\\Ubuntu-24.04\\srv\\existing daemon\\config")
  assert.equal(path.posix.dirname(paths.nativeData!), "/srv/existing daemon/.codenomad")
  assert.equal(paths.data, `\\\\wsl.localhost\\Ubuntu-24.04${paths.nativeData!.replaceAll("/", "\\")}`)
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
