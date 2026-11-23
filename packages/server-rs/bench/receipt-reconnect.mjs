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
  let gate
  const server = createServer((incoming, response) => {
    if (incoming.headers.authorization !== auth || !incoming.url.startsWith("/") || incoming.url.startsWith("//"))
      return response.writeHead(403).end()
    const url = new URL(incoming.url, endpoint)
    const list = incoming.method === "GET" && url.pathname === "/api/permission/request"
    if (held && (url.pathname === "/api/event" || list || url.pathname === "/api/debug/location"))
      return response.writeHead(503).end()
    const { host, ...headers } = incoming.headers
    const upstream = request({ hostname: endpoint.hostname, port: endpoint.port, path: incoming.url, method: incoming.method, headers }, native => {
      const state = gate
      if (!state?.release && state?.session && opened > state.before && (scans.get(state.directory) ?? 0) > state.scans
          && url.pathname === `/api/session/${state.session}` && incoming.method === "GET") {
        state.release = () => {
          response.writeHead(native.statusCode, native.headers)
          native.pipe(response)
        }
        return
      }
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
    holdSession(session, directory) {
      const state = { session, directory, before: opened, scans: scans.get(directory) ?? 0, release: undefined }
      gate = state
      return state
    },
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

export async function run({ call, fixture, folder, other, data }) {
  const { resolveConfigLocation } = await fromDist("config/location.js")
  const storage = path.join(data ?? resolveConfigLocation(path.join(fixture.root, "ts.yaml")).baseDir, "permission-receipts")
  const opened = await call("/api/workspaces", post({ path: folder }))
  assert.equal(opened.status, 201)
  const workspace = await opened.json()
  const second = await call("/api/workspaces", post({ path: other }))
  assert.equal(second.status, 201)
  const unrelated = await second.json()
  const { client } = fixture, relay = relays.get(fixture)
  const permission = [{ action: "receipt_fixture", resource: "*", effect: "ask" }]
  try {
    await until("initial upstream event subscription", () => relay.streams() > 0)
    await until("initial root recovery read finished", () => relay.scans(workspace.location.directory) > 0)
    const initialScans = relay.scans(workspace.location.directory)
    const nested = path.join(workspace.location.directory, "receipt-descendant")
    await mkdir(nested)
    const sessions = await Promise.all([workspace.location, { directory: nested }, unrelated.location]
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
      return { session, requestID, messageId, source, workspace: index === 2 ? unrelated : workspace }
    }))
    assert.equal(relay.streams(), before)
    // Suspend recovery only after it has received the pending list for this
    // session. The ordinary native reply still reaches the live event stream.
    const racing = cases[1]
    const heldSession = relay.holdSession(racing.session.id, nested)
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
    await until("recovery read the racing queue and is verifying the session", () => heldSession.release)
    const independent = cases[2]
    await until("the other project recovered while this project was held", async () =>
      (await stored(independent))?.request?.source?.messageId === independent.messageId)
    assert.equal(await stored(racing), undefined, "the request must still be uncaptured")
    await client.permission.reply({ sessionID: racing.session.id, requestID: racing.requestID, decision: "once" })
    assert(!(await client.permission.list({ sessionID: racing.session.id })).some(row => row.id === racing.requestID))
    if (data) {
      // TS queues settlement behind this snapshot. In Rust force settlement
      // to reach disk first so the re-anchoring path is actually exercised.
      const fallback = await until("Rust stored the native settlement before capture", async () => (await stored(racing))?.receipt)
      assert.equal(fallback.origin, "native")
      assert.equal(fallback.source, undefined)
      assert.deepEqual(fallback.resources, [])
    }
    heldSession.release()
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
      if (input !== racing) {
        await until("recovery persisted the pending snapshot", async () =>
          (await stored(input))?.request?.source?.messageId === input.messageId)
        await client.permission.reply({ sessionID: input.session.id, requestID: input.requestID, decision: "once" })
      }
      const storedReceipt = verify(input, await until("anchored native receipt", async () => {
        const receipt = (await stored(input))?.receipt
        return receipt?.source?.messageId === input.messageId ? receipt : null
      }))
      const read = query => call(`/api/workspaces/${input.workspace.id}/sessions/${input.session.id}/permission-receipts?${query}`)
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
    await Promise.all([workspace, unrelated].map(w => call(`/api/workspaces/${w.id}`, { method: "DELETE" })))
  }
}
