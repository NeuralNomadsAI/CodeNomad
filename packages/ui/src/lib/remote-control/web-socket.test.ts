import assert from "node:assert/strict"
import test from "node:test"
import { TunnelWebSocket, type RemoteSocketBridge } from "./web-socket"

test("tunneled WebSocket preserves text, binary, protocol, and close events", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalCloseEvent = Object.getOwnPropertyDescriptor(globalThis, "CloseEvent")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://host.remote.example/" } },
  })
  if (typeof CloseEvent === "undefined") {
    Object.defineProperty(globalThis, "CloseEvent", {
      configurable: true,
      value: class extends Event {
        readonly code: number
        readonly reason: string
        readonly wasClean: boolean
        constructor(type: string, init: CloseEventInit) {
          super(type)
          this.code = init.code ?? 0
          this.reason = init.reason ?? ""
          this.wasClean = init.wasClean ?? false
        }
      },
    })
  }
  const calls: string[] = []
  const bridge: RemoteSocketBridge = {
    connectSocket: (_socket, url, protocols) => calls.push(`open:${url.pathname}:${protocols.join(",")}`),
    transmitSocket: (_socket, data) => calls.push(`send:${typeof data === "string" ? data : "binary"}`),
    disconnectSocket: (_socket, code, reason) => calls.push(`close:${code}:${reason}`),
  }

  try {
    const socket = new TunnelWebSocket("/workspaces/demo/socket", ["v2"], bridge)
    const events: string[] = []
    socket.onopen = () => events.push("open")
    socket.onmessage = (event) => events.push(`message:${event.data}`)
    socket.onclose = (event) => events.push(`close:${event.code}:${event.wasClean}`)
    socket.buffer(12)
    assert.equal(socket.bufferedAmount, 12)
    socket.flush(5)
    assert.equal(socket.bufferedAmount, 7)
    socket.accept("v2")
    socket.receive(new TextEncoder().encode("hello"), false)
    socket.send("request")
    socket.close(1000, "done")
    socket.finish(1000, "done")

    assert.equal(socket.url, "wss://host.remote.example/workspaces/demo/socket")
    assert.equal(socket.protocol, "v2")
    assert.equal(socket.readyState, TunnelWebSocket.CLOSED)
    assert.deepEqual(calls, ["open:/workspaces/demo/socket:v2", "send:request", "close:1000:done"])
    assert.deepEqual(events, ["open", "message:hello", "close:1000:true"])
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else delete (globalThis as { window?: unknown }).window
    if (originalCloseEvent) Object.defineProperty(globalThis, "CloseEvent", originalCloseEvent)
    else delete (globalThis as { CloseEvent?: unknown }).CloseEvent
  }
})

test("tunneled WebSocket rejects transport metadata outside its bounded contract", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://host.remote.example/" } },
  })
  const bridge: RemoteSocketBridge = {
    connectSocket: () => assert.fail("invalid socket must not connect"),
    transmitSocket: () => {},
    disconnectSocket: () => {},
  }
  try {
    assert.throws(
      () => new TunnelWebSocket("/api/socket", Array.from({ length: 17 }, () => crypto.randomUUID()), bridge),
      /Invalid WebSocket protocol/,
    )
    assert.throws(
      () => new TunnelWebSocket("/api/socket", [1] as unknown as string[], bridge),
      /Invalid WebSocket protocol/,
    )
    const socket = new TunnelWebSocket("/api/socket", undefined, {
      ...bridge,
      connectSocket: () => {},
    })
    assert.throws(() => socket.close(Number.NaN), /Invalid WebSocket close code/)
    assert.throws(() => socket.close(3000.5), /Invalid WebSocket close code/)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else delete (globalThis as { window?: unknown }).window
  }
})
