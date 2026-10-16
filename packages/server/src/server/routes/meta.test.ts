import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import type { ServerMeta } from "../../api-types"
import { registerMetaRoutes } from "./meta"
import { serverOperatingSystemName } from "../os-name"

test("metadata reports the backend process platform regardless of client user agent", async () => {
  const app = Fastify()
  const meta: ServerMeta = {
    localUrl: "http://127.0.0.1:9899", eventsUrl: "/api/events", host: "127.0.0.1",
    listeningMode: "local", localPort: 9899, hostLabel: "fixture", workspaceRoot: "/fixture", addresses: [],
  }
  registerMetaRoutes(app, { serverMeta: meta })
  // `name` is the server's readable OS release (#979); it is omitted when the OS
  // does not report one, so JSON then carries only platform and arch.
  const name = serverOperatingSystemName()
  const expected = { platform: process.platform, arch: process.arch, ...(name === undefined ? {} : { name }) }
  if (process.platform === "win32" || process.platform === "darwin" || process.platform === "linux") {
    assert.equal(typeof name, "string", "supported server platforms report a readable release")
    assert.ok(name!.trim().length > 0)
  }
  try {
    for (const userAgent of ["Windows NT 10.0; Win64; x64", "Linux aarch64", "Macintosh; Intel Mac OS X"]) {
      const response = await app.inject({ url: "/api/meta", headers: { "user-agent": userAgent } })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().system, expected)
      assert.equal(response.json().workspaceRoot, meta.workspaceRoot)
    }
    assert.equal(meta.system, undefined, "route must not mutate shared metadata")
    meta.system = { platform: "client-provided-platform", arch: "client-provided-arch", name: "client-provided-name" }
    const response = await app.inject({ url: "/api/meta" })
    assert.deepEqual(response.json().system, expected,
      "backend process metadata takes precedence over a stale seeded snapshot")
  } finally { await app.close() }
})
