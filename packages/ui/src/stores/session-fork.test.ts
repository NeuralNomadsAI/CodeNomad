import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient } from "./opencode-client"
import { forkAfterMessage } from "./session-fork"

function fixture(pages: any[]) {
  const reads: any[] = [], writes: any[] = [], removed: string[] = []
  let current = true
  let tail = "answer"
  const client = {
    message: { list: async (input: any) => { reads.push(input); return pages.shift() } },
    session: {
      fork: async (input: any) => {
        writes.push(input)
        return { id: "fork", fork: { sessionID: "source", boundary: input.before
          ? { type: "before", messageID: input.before }
          : { type: "through", messageID: tail } } }
      },
      remove: async ({ sessionID }: any) => { removed.push(sessionID) },
    },
  } as unknown as OpenCodeClient
  return { client, reads, writes, removed, isCurrent: () => current,
    invalidate: () => { current = false }, setTail: (id: string) => { tail = id } }
}
const user = (id: string) => ({ id, type: "user", time: { created: 1 }, text: id })
const answer = { id: "answer", type: "assistant", time: { created: 2, completed: 3 } }

test("fork after a prompt preserves it and cuts before its answer", async () => {
  const f = fixture([{ data: [answer, user("question")], cursor: {} }])
  await forkAfterMessage(f.client, "source", "question", f.isCurrent)
  assert.deepEqual(f.writes, [{ sessionID: "source", before: "answer" }])
})

test("fork after an answer uses its hidden native successor across page boundaries", async () => {
  const f = fixture([
    { data: [user("later"), { id: "hidden", type: "model-switched" }], cursor: { next: "page2" } },
    { data: [], cursor: { next: "page3" } },
    { data: [answer, user("question")], cursor: {} },
  ])
  await forkAfterMessage(f.client, "source", "answer", f.isCurrent)
  assert.deepEqual(f.writes, [{ sessionID: "source", before: "hidden" }])
  assert.deepEqual(f.reads, [
    { sessionID: "source", limit: 200, order: "desc" },
    { sessionID: "source", limit: 200, cursor: "page2" },
    { sessionID: "source", limit: 200, cursor: "page3" },
  ])
})

test("fork after either role at the native tail includes the selected message", async () => {
  for (const message of [answer, user("question")]) {
    const f = fixture([{ data: [message], cursor: {} }])
    f.setTail(message.id)
    assert.equal((await forkAfterMessage(f.client, "source", message.id, f.isCurrent)).id, "fork")
    assert.deepEqual(f.writes, [{ sessionID: "source" }])
    assert.deepEqual(f.removed, [])
  }
})

test("a concurrent append cannot silently extend a tail fork", async () => {
  const f = fixture([{ data: [answer], cursor: {} }])
  f.setTail("concurrent")
  await assert.rejects(forkAfterMessage(f.client, "source", "answer", f.isCurrent), /Session changed/)
  assert.deepEqual(f.removed, ["fork"])
  assert.equal(f.writes.length, 1)
})

test("missing selections, unfinished responses, and repeated cursors never create forks", async () => {
  for (const [pages, error] of [
    [[{ data: [user("other")], cursor: {} }], /no longer exists/],
    [[{ data: [{ ...answer, time: { created: 2 } }], cursor: {} }], /unfinished/],
    [[{ data: [], cursor: { next: "repeat" } }, { data: [], cursor: { next: "repeat" } }], /Repeated/],
  ] as const) {
    const f = fixture([...pages])
    await assert.rejects(forkAfterMessage(f.client, "source", "answer", f.isCurrent), error)
    assert.deepEqual(f.writes, [])
  }
})

test("reconnect during history lookup prevents the write", async () => {
  const f = fixture([])
  f.client.message.list = async () => { f.invalidate(); return { data: [answer], cursor: {} } as any }
  await assert.rejects(forkAfterMessage(f.client, "source", "answer", f.isCurrent), /superseded/)
  assert.deepEqual(f.writes, [])
})

test("reconnect during fork prevents publication or cleanup on the replacement connection", async () => {
  const f = fixture([{ data: [answer], cursor: {} }])
  const fork = f.client.session.fork
  f.client.session.fork = async (...args) => { const result = await fork(...args); f.invalidate(); return result }
  await assert.rejects(forkAfterMessage(f.client, "source", "answer", f.isCurrent), /superseded/)
  assert.deepEqual(f.removed, [])
})
