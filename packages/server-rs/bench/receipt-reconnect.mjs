import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile } from "node:fs/promises"
import { createServer, request } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fromDist } from "./fixtures.mjs"

const hash = text => createHash("sha256").update(text).digest("hex")
const relays = new WeakMap()
const post = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

export async function nativeRelay(fixture) {
  const endpoint = new URL(fixture.connection.endpoint.url)
  assert.equal(endpoint.hostname, "127.0.0.1")
  const auth = `Basic ${Buffer.from(`opencode:${fixture.connection.endpoint.auth.password}`).toString("base64")}`
  const streams = new Set()
  const scans = new Map()
  let held = false, opened = 0
  const server = createServer((incoming, response) => {
    if (incoming.headers.authorization !== auth || !incoming.url.startsWith("/") || incoming.url.startsWith("//"))
      return response.writeHead(403).end()
    const url = new URL(incoming.url, endpoint)
    const list = incoming.method === "GET" && url.pathname === "/api/permission/request"
    if (held && (url.pathname === "/api/event" || list || url.pathname === "/api/debug/location"))
      return response.writeHead(503).end()
    const { host, ...headers } = incoming.headers
    const upstream = request({ hostname: endpoint.hostname, port: endpoint.port, path: incoming.url, method: incoming.method, headers }, native => {
      if (url.pathname === "/api/event" && native.statusCode === 200) {
        opened++
        streams.add(response)
      }
      if (list && native.statusCode === 200) {
        const directory = url.searchParams.get("location[directory]")
        native.once("end", () => scans.set(directory, (scans.get(directory) ?? 0) + 1))
      }
      response.writeHead(native.statusCode, native.headers)
      native.pipe(response)
    })
    upstream.on("error", () => response.destroy())
    response.on("close", () => { streams.delete(response); upstream.destroy() })
    incoming.pipe(upstream)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const relay = {
    url: `http://127.0.0.1:${server.address().port}`,
    streams: () => opened,
    scans: directory => scans.get(directory) ?? 0,
    disconnect() {
      held = true
      for (const stream of streams) stream.destroy()
    },
    reconnect() { held = false },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }),
  }
  relays.set(fixture, relay)
  return relay
}

async function until(label, read) {
  const deadline = Date.now() + 25_000
  for (;;) {
    const result = await read()
    if (result) return result
    assert(Date.now() < deadline, label)
    await delay(35)
  }
}

export async function run({ call, fixture, folder, data }) {
  const { resolveConfigLocation } = await fromDist("config/location.js")
  const storage = path.join(data ?? resolveConfigLocation(path.join(fixture.root, "ts.yaml")).baseDir, "permission-receipts")
  const opened = await call("/api/workspaces", post({ path: folder }))
  assert.equal(opened.status, 201)
  const workspace = await opened.json()
  const { client } = fixture, relay = relays.get(fixture)
  const permission = [{ action: "receipt_fixture", resource: "*", effect: "ask" }]
  try {
    await until("initial upstream event subscription", () => relay.streams() > 0)
    await until("initial root recovery read finished", () => relay.scans(workspace.location.directory) > 0)
    const initialScans = relay.scans(workspace.location.directory)
    const nested = path.join(workspace.location.directory, "receipt-descendant")
    await mkdir(nested)
    const sessions = await Promise.all([workspace.location, { directory: nested }]
      .map(location => client.session.create({ location, permissions: permission })))
    const before = relay.streams()
    relay.disconnect()
    const cases = await Promise.all(sessions.map(async (session, index) => {
      const requestID = `per_fixture_receipt_reconnect_${index}`, messageId = `msg_fixture_receipt_reconnect_${index}`
      const source = { type: "tool", messageID: messageId, id: "call_fixture" }
      void client.permission.create({ sessionID: session.id, id: requestID, action: "receipt_fixture",
        resources: ["file-one", "file-two"], source }).catch(() => {})
      const pending = await until("permission queued while relay disconnected", async () =>
        (await client.permission.list({ sessionID: session.id })).find(row => row.id === requestID))
      assert.deepEqual(pending.source, source)
      return { session, requestID, messageId, source }
    }))
    assert.equal(relay.streams(), before)
    relay.reconnect()
    await until("new upstream event subscription", () => relay.streams() > before)
    await until("new subscription recovered both native queues", () =>
      relay.scans(workspace.location.directory) > initialScans && relay.scans(nested) > 0)
    const stored = async ({ session, requestID }) => {
      for (const scope of await readdir(storage).catch(error => { if (error.code === "ENOENT") return []; throw error })) {
        const record = await readFile(path.join(storage, scope, hash(session.id), `${hash(requestID)}.json`), "utf8")
          .catch(error => { if (error.code === "ENOENT") return; throw error })
        if (record) return JSON.parse(record)
      }
    }
    const verify = ({ session, requestID, messageId, source }, receipt) => {
      const { sessionId, resolvedAt, ...value } = receipt
      assert.equal(sessionId, session.id)
      assert(Number.isFinite(resolvedAt) && resolvedAt > 0)
      assert.deepEqual(value, { requestId: requestID, source: { messageId, callId: source.id }, decision: "once",
        origin: "native", resources: ["file-one", "file-two"], action: "receipt_fixture" })
      return value
    }
    const receipts = []
    for (const input of cases) {
      await until("recovery persisted the pending snapshot", async () =>
        (await stored(input))?.request?.source?.messageId === input.messageId)
      // A proxied reply would capture the pending request itself.
      await client.permission.reply({ sessionID: input.session.id, requestID: input.requestID, decision: "once" })
      const storedReceipt = verify(input, await until("anchored native receipt", async () => (await stored(input))?.receipt))
      const read = query => call(`/api/workspaces/${workspace.id}/sessions/${input.session.id}/permission-receipts?${query}`)
      const response = await read(`messageId=${input.messageId}`)
      assert.equal(response.status, 200, await response.clone().text())
      const [receipt] = (await response.json()).receipts
      assert.deepEqual(verify(input, receipt), storedReceipt)
      assert.deepEqual(await (await read("unanchored=true")).json(), { receipts: [] })
      receipts.push(storedReceipt)
    }
    return receipts
  } finally {
    relay.reconnect()
    await call(`/api/workspaces/${workspace.id}`, { method: "DELETE" })
  }
}
