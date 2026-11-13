import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import type { ServerMeta } from "../api-types"
import { registerDirectOriginPolicy } from "./direct-origin"

async function serve(host: string, allowedOrigins?: string[], devServerUrl?: string) {
  const app = Fastify()
  const meta = { localUrl: "", addresses: [] } as unknown as ServerMeta
  registerDirectOriginPolicy(app, { meta, allowedOrigins, devServerUrl, publicHost: () => null, isPreview: () => false })
  app.post("/api/workspaces", async () => ({ ok: true }))
  await app.listen({ host, port: 0 })
  const port = (app.server.address() as { port: number }).port
  // index.ts publishes the loopback URL whenever a listener accepts loopback.
  meta.localUrl = `http://127.0.0.1:${port}`
  const target = host === "::1" ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`
  const post = async (origin?: string) => (await fetch(`${target}/api/workspaces`, {
    method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: "{}",
  })).status
  return { app, port, post }
}

const cases: Array<[bind: string, accepted: (port: number) => string[], rejected: (port: number) => string[]]> = [
  ["127.0.0.1", p => [`http://127.0.0.1:${p}`, `http://localhost:${p}`], p => [`http://[::1]:${p}`, `http://127.0.0.2:${p}`]],
  ["0.0.0.0", p => [`http://127.0.0.1:${p}`, `http://localhost:${p}`], p => [`http://[::1]:${p}`, `http://127.0.0.2:${p}`]],
  ["::", p => [`http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://[::1]:${p}`], p => [`http://127.0.0.2:${p}`]],
]

for (const [host, accepted, rejected] of cases) {
  test(`a local page reaches its own ${host} listener under the loopback names that bind covers`, async () => {
    const { app, port, post } = await serve(host)
    try {
      for (const origin of [...accepted(port), undefined]) assert.equal(await post(origin), 200, `${origin}`)
      // Loopback addresses the socket does not own, another port, a foreign site, another scheme
      // or a non-canonical origin stay rejected.
      for (const origin of [...rejected(port), `http://localhost:${port + 1}`, "https://example.com", `ftp://localhost:${port}`,
        "null", `http://localhost:${port}/path`, `http://LOCALHOST:${port}`]) {
        assert.equal(await post(origin), 403, origin)
      }
    } finally { await app.close() }
  })
}

test("configured and development origins stay exact: their ports open no loopback page", async () => {
  const { app, port, post } = await serve("127.0.0.1", ["https://ui.example.test:64161"], "http://localhost:5173")
  try {
    assert.equal(await post("https://ui.example.test:64161"), 200)
    assert.equal(await post("http://localhost:5173"), 200)
    for (const origin of ["http://127.0.0.1:64161", "http://localhost:64161", "https://localhost:64161", "http://127.0.0.1:5173"]) {
      assert.equal(await post(origin), 403, origin)
    }
    assert.notEqual(port, 64161)
  } finally { await app.close() }
})

test("a request from another machine never passes as loopback", async () => {
  const { app, port } = await serve("0.0.0.0")
  try {
    const response = await app.inject({ method: "POST", url: "/api/workspaces", remoteAddress: "192.168.1.20",
      headers: { "content-type": "application/json", origin: `http://localhost:${port}` }, payload: "{}" })
    assert.equal(response.statusCode, 403)
  } finally { await app.close() }
})
