import assert from "node:assert/strict"
import test from "node:test"

import type { OpenCodeClient } from "./opencode-client.ts"
import { listAllSessionMessages } from "./session-message-pages.ts"

test("loads every cursor page", async () => {
  const requests: unknown[] = []
  const responses = [
    { data: [{ id: "one" }], cursor: { next: "next-page" } },
    { data: [{ id: "two" }] },
  ]
  const client = {
    message: {
      list: async (request: unknown) => {
        requests.push(request)
        return responses.shift()!
      },
    },
  } as unknown as OpenCodeClient

  assert.deepEqual(await listAllSessionMessages(client, "session"), [{ id: "one" }, { id: "two" }])
  assert.deepEqual(requests, [
    { sessionID: "session", limit: 200, order: "asc" },
    { sessionID: "session", limit: 200, cursor: "next-page" },
  ])
})

test("rejects the message-count ceiling before appending a page", async () => {
  const data = new Array(100_001).fill({ id: "message" })
  Object.defineProperty(data, Symbol.iterator, {
    value: () => { throw new Error("page was appended") },
  })
  const client = {
    message: { list: async () => ({ data }) },
  } as unknown as OpenCodeClient

  await assert.rejects(listAllSessionMessages(client, "large-count"), /exceeded 100000 messages/)
})

test("rejects the retained-byte ceiling without serializing the payload", async () => {
  const data = [{
    id: "large-message",
    payload: new Uint8Array(64 * 1024 * 1024 + 1),
    toJSON: () => { throw new Error("payload was serialized") },
  }]
  const client = {
    message: { list: async () => ({ data }) },
  } as unknown as OpenCodeClient

  await assert.rejects(listAllSessionMessages(client, "large-bytes"), /exceeded 64 MiB/)
})
