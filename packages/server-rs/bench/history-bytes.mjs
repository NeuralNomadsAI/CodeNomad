import assert from "node:assert/strict"
import { createServer, request } from "node:http"
import { createHash } from "node:crypto"

const MAX = 24 * 1024 * 1024
const extensions = Array.from({ length: 16 }, (_, i) => `"stamp${i}":1e1`).join(",")
const output = Array.from({ length: 2 }, (_, i) => `{"id":"msg_${i}","type":"user","time":{"created":1e1,${extensions}},"text":"@${i}@"}`)
const window = `{"status":"window","latest":true,"resume":{"kind":"latest"},"older":null,"newer":null,"messages":[${output.join(",")}]}`
const wrap = json => `{"output":${json}}`
const pad = MAX - Buffer.byteLength(wrap(window)) + 6
const expected = window.replace("@0@", "a".repeat(Math.floor(pad / 2))).replace("@1@", "b".repeat(Math.ceil(pad / 2)))
assert.equal(Buffer.byteLength(wrap(expected)), MAX)
const expectedDigest = createHash("sha256").update(expected).digest("hex")

export async function nativeRelay(fixture) {
  const endpoint = new URL(fixture.connection.endpoint.url)
  assert.equal(endpoint.hostname, "127.0.0.1")
  const authorization = `Basic ${Buffer.from(`opencode:${fixture.connection.endpoint.auth.password}`).toString("base64")}`
  const server = createServer((incoming, response) => {
    if (incoming.headers.authorization !== authorization || !incoming.url.startsWith("/") || incoming.url.startsWith("//")) {
      return response.writeHead(403).end()
    }
    if (incoming.method === "POST" && incoming.url.startsWith("/api/rpc/codenomad.session-pruning/window?")) {
      incoming.resume()
      return response.writeHead(200, { "content-type": "application/json" }).end(wrap(expected))
    }
    const { host, ...headers } = incoming.headers
    const upstream = request({ hostname: endpoint.hostname, port: endpoint.port, path: incoming.url, method: incoming.method, headers }, native => {
      response.writeHead(native.statusCode, native.headers)
      native.pipe(response)
    })
    upstream.on("error", () => response.destroy())
    response.on("close", () => upstream.destroy())
    incoming.pipe(upstream)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }) }
}

const post = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

export async function run({ call, fixture, folder, data }) {
  const workspace = await call("/api/workspaces", post({ path: folder }))
  assert.equal(workspace.status, 201)
  const { id, location } = await workspace.json()
  try {
    const session = await fixture.client.session.create({ location, title: "History wire budget" })
    const response = await call(`/api/workspaces/${id}/session-history/window`, post({ sessionID: session.id, target: { kind: "latest" } }))
    assert.equal(response.status, 200)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert(bytes.length <= MAX)
    // Rust can preserve the validated JSON slice; the TS SDK exposes a decoded value.
    if (data) assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedDigest)
    const page = JSON.parse(bytes)
    assert.deepEqual(page, JSON.parse(expected))
    return { status: page.status, count: page.messages.length, withinBudget: true }
  } finally {
    await call(`/api/workspaces/${id}`, { method: "DELETE" })
  }
}
