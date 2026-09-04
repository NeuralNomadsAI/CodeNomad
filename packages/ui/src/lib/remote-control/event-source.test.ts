import assert from "node:assert/strict"
import test from "node:test"
import { TunnelEventSource } from "./event-source"

test("tunneled EventSource parses named and multiline SSE events", async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://host.remote.example/" } },
  })
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("id: 7\nevent: codenomad.client.ping\ndata: {\"ts\":1}\n\n"))
      controller.enqueue(new TextEncoder().encode("data: first\ndata: second\n\n"))
      controller.close()
    },
  }), { status: 200 })

  try {
    const source = new TunnelEventSource("/api/events", { withCredentials: true })
    const named = new Promise<MessageEvent>((resolve) => source.addEventListener("codenomad.client.ping", (event) => resolve(event as MessageEvent), { once: true }))
    const message = new Promise<MessageEvent>((resolve) => { source.onmessage = (event) => resolve(event) })
    assert.equal((await named).data, "{\"ts\":1}")
    assert.equal((await message).data, "first\nsecond")
    assert.equal(source.withCredentials, true)
    source.close()
    assert.equal(source.readyState, TunnelEventSource.CLOSED)
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else delete (globalThis as { window?: unknown }).window
  }
})

test("tunneled EventSource reconnects with the last event identifier", async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://host.remote.example/" } },
  })
  const requests: RequestInit[] = []
  globalThis.fetch = async (_input, init) => {
    requests.push(init ?? {})
    const body = requests.length === 1 ? "retry: 1\nid: event-7\ndata: first\n\n" : "data: second\n\n"
    return new Response(body, { status: 200 })
  }

  try {
    const source = new TunnelEventSource("/api/events")
    const messages: string[] = []
    await new Promise<void>((resolve) => {
      source.onmessage = (event) => {
        messages.push(String(event.data))
        if (messages.length === 2) resolve()
      }
    })
    source.close()
    assert.deepEqual(messages, ["first", "second"])
    assert.equal(new Headers(requests[1].headers).get("last-event-id"), "event-7")
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else delete (globalThis as { window?: unknown }).window
  }
})
