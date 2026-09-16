import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot } from "solid-js"
import { OpenCode, type OpenCodeEvent } from "@opencode/client"
import { createData } from "@opencode/client/solid"
import { createRuntimeFetch } from "../../../server/src/opencode/compatibility/transport"
import { rememberRuntime } from "../../../server/src/opencode/compatibility/runtime"
import { normalizeRuntimeEvent } from "../../../server/src/opencode/compatibility/events"
import { normalizeSessionMessage } from "./message-v2/normalizers"

test("legacy pending HTTP data and enqueued SSE materialize through the actual stable reducer", async () => {
  const endpoint = { url: "http://127.0.0.1:4321" }
  rememberRuntime(endpoint, { version: "2.0.3", pid: 1, discovery: "health" })
  const item = { id: "inbox", sessionID: "session", type: "user", payload: { text: "Pending" }, delivery: "queue", timeCreated: 123 }
  const api = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint, async () => Response.json({ data: [item] })) })
  let dispose!: () => void
  let emit!: (event: { name: OpenCodeEvent["type"]; details: OpenCodeEvent }) => void
  const data = createRoot(cleanup => {
    dispose = cleanup
    return createData({ directory: "/fixture", api: () => api, event: { on: () => () => {}, listen: listener => { emit = listener; return () => {} } } })
  })
  try {
    await data.session.pending.sync("session")
    assert.equal(data.session.message.list("session")[0].time.created, 123)
    const event = normalizeRuntimeEvent({ id: "event", created: 456, type: "session.inbox.enqueued",
      data: { sessionID: "session", inboxID: "second", item: { type: "user", payload: { text: "Second" }, delivery: "queue" } },
    } as OpenCodeEvent)
    emit({ name: event.type, details: event })
    assert.equal(data.session.message.list("session").find(message => message.id === "second")?.time.created, 456)
  } finally { dispose() }
})

test("idle control records retain native identity/outcome without inventing assistant text", () => {
  for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
    const result = normalizeSessionMessage("session", { id: "idle", type: "idle", outcome, time: { created: 123 } })
    assert.equal(result.message.id, "idle")
    assert.deepEqual(result.message.parts, [])
    assert.equal(result.info.time.completed, 123)
    assert.equal(result.message.status, outcome === "succeeded" ? "complete" : "error")
  }
})
