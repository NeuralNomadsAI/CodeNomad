import assert from "node:assert/strict"
import { test } from "node:test"

import { createBrowserEventConnector } from "./browser-event-transport.ts"

function response(body: string): Response {
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

test("browser stream reconnects with the last parsed id and receives missed events", async () => {
  const requests: Headers[] = []
  const responses = [
    response('id: epoch-a:1\ndata: {"type":"workspace.log","entry":{"sequence":1}}\n\n'),
    response('id: epoch-a:2\ndata: {"type":"workspace.log","entry":{"sequence":2}}\n\n'),
  ]
  const connect = createBrowserEventConnector(async (_url, init) => {
    requests.push(new Headers(init?.headers))
    return responses.shift()!
  })
  const sequences: number[] = []
  const callbacks = {
    onEvent: (event: any) => {
      sequences.push(event.entry.sequence)
    },
  }

  await connect("http://localhost/api/events", callbacks).finished
  await connect("http://localhost/api/events", callbacks).finished

  assert.equal(requests[0]!.get("Last-Event-ID"), null)
  assert.equal(requests[1]!.get("Last-Event-ID"), "epoch-a:1")
  assert.deepEqual(sequences, [1, 2])
})

test("browser stream advances its cursor and requests resync on replay overflow", async () => {
  const requests: Headers[] = []
  const responses = [
    response('event: codenomad.replay.cursor\nid: epoch-a:1\ndata: {}\n\n'),
    response('event: codenomad.replay.reset\nid: epoch-a:5\ndata: {}\n\n'),
    response('id: epoch-a:6\ndata: {"type":"workspace.log","entry":{"sequence":6}}\n\n'),
  ]
  const connect = createBrowserEventConnector(async (_url, init) => {
    requests.push(new Headers(init?.headers))
    return responses.shift()!
  })
  let resets = 0
  const callbacks = {
    onEvent() {},
    onReplayReset: () => {
      resets += 1
    },
  }

  await connect("http://localhost/api/events", callbacks).finished
  await connect("http://localhost/api/events", callbacks).finished
  await connect("http://localhost/api/events", callbacks).finished

  assert.equal(requests[1]!.get("Last-Event-ID"), "epoch-a:1")
  assert.equal(requests[2]!.get("Last-Event-ID"), "epoch-a:5")
  assert.equal(resets, 1)
})

test("a replaced browser stream cannot dispatch or advance from stale frames", async () => {
  const requests: Headers[] = []
  let firstController: ReadableStreamDefaultController<Uint8Array> | undefined
  const firstBody = new ReadableStream<Uint8Array>({
    start(controller) {
      firstController = controller
    },
  })
  const responses = [
    new Response(firstBody, { status: 200 }),
    response('id: epoch-a:2\ndata: {"type":"workspace.log","entry":{"sequence":2}}\n\n'),
    response('id: epoch-a:3\ndata: {"type":"workspace.log","entry":{"sequence":3}}\n\n'),
  ]
  const connect = createBrowserEventConnector(async (_url, init) => {
    requests.push(new Headers(init?.headers))
    return responses.shift()!
  })
  const sequences: number[] = []
  const callbacks = {
    onEvent: (event: any) => {
      sequences.push(event.entry.sequence)
    },
  }

  const stale = connect("http://localhost/api/events", callbacks)
  await Promise.resolve()
  const current = connect("http://localhost/api/events", callbacks)
  firstController!.enqueue(new TextEncoder().encode('id: epoch-a:1\ndata: {"type":"workspace.log","entry":{"sequence":1}}\n\n'))
  firstController!.close()
  await Promise.all([stale.finished, current.finished])
  await connect("http://localhost/api/events", callbacks).finished

  assert.deepEqual(sequences, [2, 3])
  assert.equal(requests[2]!.get("Last-Event-ID"), "epoch-a:2")
})

test("truncated and invalid frames do not advance the browser cursor", async () => {
  const requests: Headers[] = []
  const responses = [
    response('id: epoch-a:1\ndata: {"type":"workspace.log"}'),
    response('id: epoch-a:2\ndata: not-json\n\n'),
    response('id: epoch-a:3\ndata: {"type":"workspace.log","entry":{"sequence":3}}\n\n'),
    response('event: codenomad.replay.cursor\nid: epoch-a:3\ndata: {}\n\n'),
  ]
  const connect = createBrowserEventConnector(async (_url, init) => {
    requests.push(new Headers(init?.headers))
    return responses.shift()!
  })
  const callbacks = { onEvent() {} }

  for (let index = 0; index < 4; index += 1) {
    await connect("http://localhost/api/events", callbacks).finished
  }

  assert.deepEqual(requests.map((headers) => headers.get("Last-Event-ID")), [null, null, null, "epoch-a:3"])
})
