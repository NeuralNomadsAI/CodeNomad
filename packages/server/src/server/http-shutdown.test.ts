import assert from "node:assert/strict"
import { once } from "node:events"
import { get } from "node:http"
import { connect, type Socket } from "node:net"
import test from "node:test"
import { AuthManager } from "../auth/manager"
import { ClientConnectionManager } from "../clients/connection-manager"
import { EventBus } from "../events/bus"
import { createLogger } from "../logger"
import { createHttpServer } from "./http-server"

test("HTTP shutdown ends SSE and upgraded connections without waiting for clients", { timeout: 2_000 }, async t => {
  const logger = createLogger({ level: "silent" } as never)
  const stub = new Proxy({}, { get: () => () => undefined }) as never
  const connections = new ClientConnectionManager(logger)
  const events = new EventBus()
  const server = createHttpServer({
    bindHost: "127.0.0.1", bindPort: 0, defaultPort: 0, protocol: "http",
    workspaceManager: stub, settings: stub, fileSystemBrowser: stub, eventBus: events,
    serverMeta: { localUrl: "http://localhost:0", addresses: [] } as never,
    instanceStore: stub, speechService: stub, sidecarManager: stub, previewManager: stub,
    authManager: new AuthManager({ dangerouslySkipAuth: true } as never, logger),
    clientConnectionManager: connections, remoteProxySessionManager: stub,
    remoteControlManager: { gate: () => ({}), previewsAllowed: () => true } as never,
    yoloManager: stub, nativeParent: stub, automationBridgeToken: "test-bridge", uiStaticDir: "", logger,
  })
  const bus = server.instance
  // An accepted durable mutation must finish before the server reports closed.
  let writing!: () => void
  let release!: () => void
  const startedWrite = new Promise<void>(resolve => { writing = resolve })
  bus.get("/api/shutdown-test-write", async () => {
    writing()
    await new Promise<void>(resolve => { release = resolve })
    return { persisted: true }
  })
  let serverUpgrade: Socket | undefined
  // The real preview/SideCar upgrade transports leave HTTP's connection pool.
  bus.server.on("upgrade", (request, socket) => {
    if (request.url === "/shutdown-test") {
      serverUpgrade = socket as Socket
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
    }
  })
  const { port } = await server.start()
  const request = get(`http://127.0.0.1:${port}/api/events?clientId=test&connectionId=test`)
  const [response] = await once(request, "response")
  response.on("error", () => {})
  response.pause()
  const upgraded = connect(port, "127.0.0.1")
  t.after(async () => { release?.(); request.destroy(); upgraded.destroy(); serverUpgrade?.destroy(); connections.shutdown(); await server.stop() })
  await once(upgraded, "connect")
  upgraded.write("GET /shutdown-test HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
  await once(upgraded, "data")
  events.publish({ type: "instance.event", instanceId: "w", event: { type: "session.text.delta", data: { delta: "x".repeat(8 * 1024 * 1024) } } } as never)
  const mutation = get(`http://127.0.0.1:${port}/api/shutdown-test-write`)
  const mutationResponse = once(mutation, "response")
  await startedWrite
  const started = performance.now()
  let stopped = false
  const stopping = server.stop().then(() => { stopped = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(stopped, false)
  release()
  const [persisted] = await mutationResponse
  persisted.resume()
  assert.equal(persisted.statusCode, 200)
  await stopping
  assert.ok(performance.now() - started < 1_000)
})
