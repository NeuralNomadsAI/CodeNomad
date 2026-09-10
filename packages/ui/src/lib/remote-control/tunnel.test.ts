import assert from "node:assert/strict"
import test from "node:test"
import { createHostHandshake } from "@codenomad/remote-control-protocol"
import { RemoteControlTunnel } from "./tunnel"

async function fixture(t: test.TestContext) {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair
  const host = await createHostHandshake(await crypto.subtle.exportKey("jwk", keys.privateKey))
  let socket!: StrictSocket
  let sent!: () => void
  const requestSent = new Promise<void>((resolve) => { sent = resolve })
  class StrictSocket extends EventTarget {
    static OPEN = 1
    static CLOSING = 2
    readyState = 1
    bufferedAmount = 0
    binaryType = ""
    closedWith?: number
    encryptedSends = 0
    constructor(_url: URL) {
      super()
      socket = this
      queueMicrotask(() => this.dispatchEvent(new Event("open")))
    }
    send(data: string | Uint8Array) {
      if (typeof data === "string") {
        void host.accept(data).then(({ ready }) => {
          this.dispatchEvent(new MessageEvent("message", { data: ready }))
        })
      } else {
        this.encryptedSends += 1
        sent()
      }
    }
    close(code?: number) {
      if (code !== undefined && code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) {
        throw new DOMException("Invalid close code", "InvalidAccessError")
      }
      this.closedWith = code
      this.readyState = 3
      queueMicrotask(() => this.dispatchEvent(new Event("close")))
    }
  }
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const oldSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://relay.example/" } } })
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: StrictSocket })
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (oldSocket) Object.defineProperty(globalThis, "WebSocket", oldSocket)
    else Reflect.deleteProperty(globalThis, "WebSocket")
  })
  const tunnel = new RemoteControlTunnel(
    { tunnelPath: "/__codenomad/tunnel" },
    await crypto.subtle.exportKey("jwk", keys.publicKey),
    StrictSocket as unknown as typeof WebSocket,
  )
  return { tunnel, requestSent, socket: () => socket }
}

test("security close uses a permitted code and rejects pending HTTP immediately", async (t) => {
  const f = await fixture(t)
  const rejected = assert.rejects(f.tunnel.fetch("/api/events"), /tunnel disconnected/)
  await f.requestSent
  f.socket().dispatchEvent(new MessageEvent("message", { data: "unexpected plaintext" }))
  await rejected
  assert.equal(f.socket().closedWith, 4000)
})

test("a stalled browser network buffer closes the tunnel without sending or replaying the next request", async (t) => {
  const f = await fixture(t)
  const rejected = assert.rejects(f.tunnel.fetch("/api/events"), /tunnel disconnected/)
  await f.requestSent
  f.socket().bufferedAmount = 24 * 1024 * 1024
  await assert.rejects(f.tunnel.fetch("/api/items", { method: "POST", body: "mutation" }), /tunnel disconnected/)
  await rejected
  assert.equal(f.socket().encryptedSends, 1)
  assert.equal(f.socket().closedWith, 4000)
})
