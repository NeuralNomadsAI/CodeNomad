import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { createServer as createNetServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import test from "node:test"
import { createClientHandshake, decodeBase64, encodeBase64, type EncryptedChannel, type HostToClientMessage } from "@codenomad/remote-control-protocol"
import { WebSocket } from "undici"
import { loadOrCreateRemoteControlIdentity } from "../../server/src/remote-control/identity"
import { RemoteControlManager } from "../../server/src/remote-control/manager"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const wranglerBin = join(packageRoot, "node_modules", "wrangler", "bin", "wrangler.js")

test("hibernating relay carries opaque HTTP streams and WebSockets end to end", async () => {
  const port = await availablePort()
  const stateDirectory = mkdtempSync(join(tmpdir(), "codenomad-relay-state-"))
  const identityDirectory = mkdtempSync(join(tmpdir(), "codenomad-relay-identity-"))
  const local = createLocalServer()
  local.server.listen(0, "127.0.0.1")
  await once(local.server, "listening")
  const address = local.server.address()
  assert(address && typeof address !== "string")
  const relay = startRelay(port, stateDirectory)
  const identity = loadOrCreateRemoteControlIdentity(identityDirectory)
  const manager = new RemoteControlManager({
    identity,
    relayUrl: `http://localhost:${port}`,
    localUrl: () => `http://127.0.0.1:${address.port}`,
    localCookie: () => "local=session",
    logger: silentLogger() as never,
  })

  try {
    await waitForRelay(port, relay)
    const started = await manager.start()
    const routeHeaders = { "x-codenomad-relay-test-host": `${identity.hostId}.localhost` }
    await replaceHostConnection(port, identity.hostId, identity.secret)
    await waitForCondition(() => manager.status().state !== "connected", "Connector did not observe host replacement")
    await waitForCondition(() => manager.status().state === "connected", "Connector did not reconnect")

    const stalePairing = decodePairing(started.pairing.url)
    const staleExchange = await fetch(`http://127.0.0.1:${port}/__codenomad/pair`, {
      method: "POST",
      headers: { ...routeHeaders, "content-type": "application/json" },
      body: JSON.stringify({ token: stalePairing.token, name: "Stale pairing" }),
    })
    assert.equal(staleExchange.status, 401)
    const pairing = decodePairing((await manager.createPairing()).url)
    const oversized = await fetch(`http://127.0.0.1:${port}/__codenomad/pair`, {
      method: "POST",
      headers: { ...routeHeaders, "content-type": "application/json" },
      body: JSON.stringify({ token: "x".repeat(5_000) }),
    })
    assert.equal(oversized.status, 400)

    const paired = await fetch(`http://127.0.0.1:${port}/__codenomad/pair`, {
      method: "POST",
      headers: { ...routeHeaders, "content-type": "application/json" },
      body: JSON.stringify({ token: pairing.token, name: "E2E device" }),
    })
    assert.equal(paired.status, 204)
    const cookie = paired.headers.get("set-cookie")
    assert(cookie)
    const replayedPairing = await fetch(`http://127.0.0.1:${port}/__codenomad/pair`, {
      method: "POST",
      headers: { ...routeHeaders, "content-type": "application/json" },
      body: JSON.stringify({ token: pairing.token, name: "Replay" }),
    })
    assert.equal(replayedPairing.status, 401)

    const directApi = await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: { ...routeHeaders, cookie } })
    assert.equal(directApi.status, 426)

    const client = await EncryptedRelayClient.connect(port, routeHeaders, cookie, pairing.hostPublicKey)
    const extraClients: EncryptedRelayClient[] = []
    try {
      const streamId = crypto.randomUUID()
      const fastId = crypto.randomUUID()
      await client.send({ type: "http.request", id: streamId, method: "GET", path: "/api/stream", headers: [] })
      await client.send({
        type: "http.request",
        id: fastId,
        method: "POST",
        path: "/api/fast?kept=1",
        headers: [["authorization", "must-not-reach-local"]],
        body: encodeBase64(new TextEncoder().encode("encrypted request body")),
      })
      const responses = await client.collectHttp([streamId, fastId])
      assert.equal(responses.get(streamId), "stream-start-stream-end")
      assert.deepEqual(client.httpCompletionOrder, [fastId, streamId])
      const fast = JSON.parse(responses.get(fastId) ?? "") as Record<string, unknown>
      assert.equal(fast.url, "/api/fast?kept=1")
      assert.equal(fast.body, "encrypted request body")
      assert.equal(fast.remote, "1")
      assert.equal(fast.authorization, undefined)
      assert.equal(fast.cookie, "local=session")

      const socketId = crypto.randomUUID()
      await client.send({ type: "socket.open", id: socketId, path: "/workspaces/socket", headers: [["authorization", "strip-me"]], protocols: [] })
      await client.waitFor((message) => message.type === "socket.ready" && message.id === socketId)
      await client.send({ type: "socket.message", id: socketId, data: encodeBase64(new TextEncoder().encode("hello")), binary: false })
      const socketReply = await client.waitFor((message) => message.type === "socket.message" && message.id === socketId)
      assert.equal(new TextDecoder().decode(decodeBase64(socketReply.data)), "echo:hello")
      assert.equal(local.socketHeaders.cookie, "local=session")
      assert.equal(local.socketHeaders.authorization, undefined)
      await client.send({ type: "socket.close", id: socketId, code: 1000, reason: "done" })

      for (let index = 0; index < 15; index += 1) {
        extraClients.push(await EncryptedRelayClient.connect(port, routeHeaders, cookie, pairing.hostPublicKey))
      }
      await assert.rejects(
        () => EncryptedRelayClient.connect(port, routeHeaders, cookie, pairing.hostPublicKey),
        /failed|timed out/i,
      )

      for (let index = 0; index < 8; index += 1) await manager.createPairing()
      await assert.rejects(() => manager.createPairing(), /Too many active pairing links/)

      const devices = await manager.devices()
      assert.equal(devices.length, 1)
      await manager.revokeDevice(devices[0].id)
      await client.waitForClose()
      const revoked = await fetch(`http://127.0.0.1:${port}/__codenomad/bootstrap`, { headers: { ...routeHeaders, cookie } })
      assert.equal(revoked.status, 401)
    } finally {
      client.close()
      for (const extra of extraClients) extra.close()
    }
  } finally {
    await manager.shutdown()
    local.server.close()
    await once(local.server, "close")
    stopRelay(relay)
    rmSync(stateDirectory, { recursive: true, force: true })
    rmSync(identityDirectory, { recursive: true, force: true })
  }
})

class EncryptedRelayClient {
  readonly httpCompletionOrder: string[] = []
  private readonly messages: HostToClientMessage[] = []
  private readonly waiters: Array<{
    predicate: (message: HostToClientMessage) => boolean
    resolve: (message: HostToClientMessage) => void
    timeout: ReturnType<typeof setTimeout>
  }> = []
  private receiveQueue = Promise.resolve()
  private sendQueue = Promise.resolve()

  private constructor(
    private readonly socket: InstanceType<typeof WebSocket>,
    private readonly channel: EncryptedChannel,
  ) {
    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) return
      this.receiveQueue = this.receiveQueue.then(async () => {
        const plaintext = await channel.decrypt(new Uint8Array(event.data))
        this.push(JSON.parse(new TextDecoder().decode(plaintext)) as HostToClientMessage)
      })
    })
  }

  static async connect(port: number, routeHeaders: Record<string, string>, cookie: string, hostPublicKey: JsonWebKey): Promise<EncryptedRelayClient> {
    const handshake = await createClientHandshake(hostPublicKey)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/__codenomad/tunnel`, { headers: { ...routeHeaders, cookie } })
    socket.binaryType = "arraybuffer"
    const channel = await new Promise<EncryptedChannel>((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timeout)
        if (socket.readyState < WebSocket.CLOSING) socket.close()
        reject(error)
      }
      const timeout = setTimeout(() => fail(new Error("Encrypted relay handshake timed out")), 15_000)
      socket.addEventListener("open", () => socket.send(handshake.hello), { once: true })
      socket.addEventListener("error", () => fail(new Error("Encrypted relay WebSocket failed")), { once: true })
      socket.addEventListener("close", () => fail(new Error("Encrypted relay WebSocket closed during handshake")), { once: true })
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return
        void handshake.accept(event.data).then((value) => {
          clearTimeout(timeout)
          resolve(value)
        }).catch(reject)
      }, { once: true })
    })
    return new EncryptedRelayClient(socket, channel)
  }

  send(message: unknown): Promise<void> {
    const plaintext = new TextEncoder().encode(JSON.stringify(message))
    this.sendQueue = this.sendQueue.then(async () => this.socket.send(await this.channel.encrypt(plaintext)))
    return this.sendQueue
  }

  async collectHttp(ids: string[]): Promise<Map<string, string>> {
    const pending = new Set(ids)
    const bodies = new Map(ids.map((id) => [id, ""]))
    while (pending.size) {
      const message = await this.waitFor((candidate) => "id" in candidate && pending.has(candidate.id))
      if (message.type === "http.chunk") {
        bodies.set(message.id, `${bodies.get(message.id)}${new TextDecoder().decode(decodeBase64(message.data))}`)
      } else if (message.type === "http.error") {
        throw new Error(message.message)
      } else if (message.type === "http.end") {
        pending.delete(message.id)
      }
    }
    return bodies
  }

  waitFor(predicate: (message: HostToClientMessage) => boolean): Promise<HostToClientMessage> {
    const index = this.messages.findIndex(predicate)
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timeout === timeout)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error("Timed out waiting for encrypted relay response"))
      }, 10_000)
      this.waiters.push({ predicate, resolve, timeout })
    })
  }

  waitForClose(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise((resolve) => this.socket.addEventListener("close", () => resolve(), { once: true }))
  }

  close(): void {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close()
  }

  private push(message: HostToClientMessage): void {
    if (message.type === "http.end") this.httpCompletionOrder.push(message.id)
    const index = this.waiters.findIndex((waiter) => waiter.predicate(message))
    if (index < 0) this.messages.push(message)
    else {
      const waiter = this.waiters.splice(index, 1)[0]
      clearTimeout(waiter.timeout)
      waiter.resolve(message)
    }
  }
}

function createLocalServer() {
  const socketHeaders: Record<string, string | undefined> = {}
  const server = createServer((request, response) => {
    if (request.headers.cookie !== "local=session") {
      response.writeHead(401).end("missing internal session")
      return
    }
    if (request.url === "/api/stream") {
      response.write("stream-start-")
      setTimeout(() => response.end("stream-end"), 150)
      return
    }
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    request.on("end", () => response.end(JSON.stringify({
      url: request.url,
      body: Buffer.concat(chunks).toString(),
      remote: request.headers["x-codenomad-remote-control"],
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    })))
  })
  server.on("upgrade", (request, socket) => {
    socketHeaders.cookie = request.headers.cookie
    socketHeaders.authorization = request.headers.authorization
    acceptEchoSocket(request, socket)
  })
  return { server, socketHeaders }
}

function acceptEchoSocket(request: IncomingMessage, socket: Socket): void {
  const key = request.headers["sec-websocket-key"]
  if (request.url !== "/workspaces/socket" || typeof key !== "string" || request.headers.cookie !== "local=session") {
    socket.destroy()
    return
  }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.on("data", (frame) => {
    if ((frame[0] & 0x0f) === 0x08) {
      socket.end()
      return
    }
    const payload = decodeClientFrame(frame)
    socket.write(serverTextFrame(`echo:${payload}`))
  })
}

function decodeClientFrame(frame: Buffer): string {
  const length = frame[1] & 0x7f
  assert(length < 126)
  const mask = frame.subarray(2, 6)
  const payload = frame.subarray(6, 6 + length)
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
  return payload.toString()
}

function serverTextFrame(value: string): Buffer {
  const payload = Buffer.from(value)
  assert(payload.length < 126)
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
}

function decodePairing(urlValue: string): { token: string; hostPublicKey: JsonWebKey } {
  const fragment = decodeURIComponent(new URL(urlValue).hash.slice(1))
  const value = JSON.parse(new TextDecoder().decode(decodeBase64(fragment))) as Record<string, unknown>
  assert.equal(value.protocol, 2)
  assert.equal(typeof value.token, "string")
  assert.equal(typeof value.hostPublicKey, "object")
  return value as { token: string; hostPublicKey: JsonWebKey }
}

function startRelay(port: number, stateDirectory: string): ChildProcess {
  return spawn(process.execPath, [
    wranglerBin,
    "dev",
    "--local",
    "--port",
    String(port),
    "--persist-to",
    stateDirectory,
    "--var",
    "REMOTE_BASE_HOST:localhost",
  ], {
    cwd: packageRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function replaceHostConnection(port: number, hostId: string, secret: string): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/hosts/${hostId}/connect`, {
    headers: { Authorization: `Bearer ${secret}` },
  })
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Replacement host did not connect")), 10_000)
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "ready", protocol: 2 })), { once: true })
    socket.addEventListener("message", () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
    socket.addEventListener("error", () => reject(new Error("Replacement host failed")), { once: true })
  })
}

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function waitForRelay(port: number, relay: ChildProcess): Promise<void> {
  const output: Buffer[] = []
  relay.stdout?.on("data", (chunk) => output.push(Buffer.from(chunk)))
  relay.stderr?.on("data", (chunk) => output.push(Buffer.from(chunk)))
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (relay.exitCode !== null) throw new Error(`Wrangler exited early:\n${Buffer.concat(output).toString()}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version.json`)
      if (response.status < 500) return
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Wrangler did not start:\n${Buffer.concat(output).toString()}`)
}

function stopRelay(relay: ChildProcess): void {
  if (!relay.pid || relay.exitCode !== null) return
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(relay.pid), "/T", "/F"], { stdio: "ignore" })
  else relay.kill("SIGTERM")
}

async function availablePort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address !== "string")
  server.close()
  await once(server, "close")
  return address.port
}

function silentLogger() {
  return {
    child() { return this },
    debug() {},
    error() {},
    info() {},
    warn() {},
  }
}
