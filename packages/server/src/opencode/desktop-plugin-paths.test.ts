import assert from "node:assert/strict"
import { test } from "node:test"
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
  assert.deepEqual(paths, { config: "C:\\daemon config", data: "C:\\daemon config\\.codenomad" })
})

test("WSL resolves the connected daemon root into its selected distro, without a shell environment", async () => {
  const paths = await resolveDesktopPluginPaths(connection([
    { type: "directory", path: "/srv/existing daemon/config" },
    { type: "directory", path: "/home/new-user/project/.opencode" },
  ]), { kind: "wsl", distro: "Ubuntu-24.04", binary: "/usr/bin/opencode" })
  assert.deepEqual(paths, {
    config: "\\\\wsl.localhost\\Ubuntu-24.04\\srv\\existing daemon\\config",
    data: "\\\\wsl.localhost\\Ubuntu-24.04\\srv\\existing daemon\\config\\.codenomad",
    nativeData: "/srv/existing daemon/config/.codenomad",
  })
})

test("POSIX hosts preserve daemon-native paths", async () => {
  assert.deepEqual(await resolveDesktopPluginPaths(connection([
    { type: "directory", path: "/srv/existing/config" },
  ]), { kind: "host", platform: "linux", binary: "/usr/bin/opencode" }), {
    config: "/srv/existing/config", data: "/srv/existing/config/.codenomad",
  })
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
})
