import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import type { ServerMeta } from "../api-types"
import { registerDirectOriginPolicy } from "./direct-origin"

async function serve(host: string) {
  const app = Fastify()
  const meta = { localUrl: "", addresses: [] } as unknown as ServerMeta
  registerDirectOriginPolicy(app, { meta, publicHost: () => null, isPreview: () => false })
  app.post("/api/workspaces", async () => ({ ok: true }))
  await app.listen({ host, port: 0 })
  const port = (app.server.address() as { port: number }).port
  // index.ts publishes the loopback URL whenever a listener accepts loopback.
  meta.localUrl = `http://127.0.0.1:${port}`
  const post = async (origin?: string) => (await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
    method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: "{}",
  })).status
  return { app, port, post }
}

for (const host of ["127.0.0.1", "0.0.0.0"]) {
  test(`a local page reaches its own ${host} listener under every loopback name`, async () => {
    const { app, port, post } = await serve(host)
    try {
      for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, undefined]) {
        assert.equal(await post(origin), 200, `${origin}`)
      }
      // Another local application, a foreign site, another scheme or a non-canonical origin stays rejected.
      for (const origin of [`http://localhost:${port + 1}`, "https://example.com", `ftp://localhost:${port}`, "null",
        `http://localhost:${port}/path`, `http://LOCALHOST:${port}`]) {
        assert.equal(await post(origin), 403, origin)
      }
    } finally { await app.close() }
  })
}

test("a request from another machine never passes as loopback", async () => {
  const { app, port } = await serve("0.0.0.0")
  try {
    const response = await app.inject({ method: "POST", url: "/api/workspaces", remoteAddress: "192.168.1.20",
      headers: { "content-type": "application/json", origin: `http://localhost:${port}` }, payload: "{}" })
    assert.equal(response.statusCode, 403)
  } finally { await app.close() }
})
