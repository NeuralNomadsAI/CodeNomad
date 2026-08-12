import assert from "node:assert/strict"
import { test } from "node:test"
import pino from "pino"

import { EventBus } from "../events/bus"
import { createHttpServer } from "./http-server"

test("browser origins and plugin callbacks use separate security gates", async () => {
  const logger = pino({ level: "silent" })
  const workspace = {
    id: "workspace",
    path: process.cwd(),
    status: "ready",
    proxyPath: "/workspaces/workspace/instance",
    binaryId: "opencode",
    binaryLabel: "opencode",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  let deletionGuardWired = false
  const workspaceManager = {
    get: (id: string) => id === workspace.id ? workspace : undefined,
    list: () => [workspace],
    getPluginCallbackAuthorizationHeader: (id: string) => id === workspace.id ? "Bearer callback-secret" : undefined,
    getInstanceAuthorizationHeader: () => "Basic shared-opencode-secret",
    setDeletionGuard: () => { deletionGuardWired = true },
  }
  const authManager = {
    isTokenBootstrapEnabled: () => false,
    isLoopbackRequest: () => true,
    getSessionFromRequest: (request: { headers: { cookie?: string } }) => request.headers.cookie === "session=valid" ? { id: "session" } : null,
  }
  const server = createHttpServer({
    bindHost: "0.0.0.0",
    bindPort: 0,
    defaultPort: 0,
    protocol: "http",
    workspaceManager,
    settings: {},
    fileSystemBrowser: {},
    eventBus: new EventBus(),
    serverMeta: {
      localUrl: "http://localhost:4000",
      remoteUrl: "http://192.168.1.2:4000",
      addresses: [],
    },
    instanceStore: {},
    speechService: {},
    sidecarManager: {},
    previewManager: {},
    authManager,
    clientConnectionManager: { pong: () => true, register: () => () => undefined },
    pluginChannel: {},
    voiceModeManager: {},
    remoteProxySessionManager: {},
    yoloManager: {},
    sessionMetadataPersistence: {},
    workflowManager: { list: async () => [] },
    uiStaticDir: "",
    uiDevServerUrl: "http://localhost:3000",
    logger,
  } as never)
  assert.equal(deletionGuardWired, true)
  await server.instance.ready()
  try {
    const hostile = await server.instance.inject({
      method: "POST",
      url: "/api/client-connections/pong",
      headers: { cookie: "session=valid", origin: "https://attacker.example" },
      payload: { clientId: "client", connectionId: "connection" },
    })
    assert.equal(hostile.statusCode, 403)
    assert.equal(hostile.headers["access-control-allow-origin"], undefined)

    const trusted = await server.instance.inject({
      method: "POST",
      url: "/api/client-connections/pong",
      headers: { cookie: "session=valid", origin: "http://localhost:3000" },
      payload: { clientId: "client", connectionId: "connection" },
    })
    assert.equal(trusted.statusCode, 204)
    assert.equal(trusted.headers["access-control-allow-origin"], "http://localhost:3000")

    const alias = await server.instance.inject({
      method: "POST",
      url: "/api/client-connections/pong",
      headers: { cookie: "session=valid", host: "codenomad.local", origin: "http://codenomad.local" },
      payload: { clientId: "client", connectionId: "connection" },
    })
    assert.equal(alias.statusCode, 204)

    for (const headers of [
      {},
      { cookie: "session=valid" },
      { authorization: "Basic shared-opencode-secret" },
    ]) {
      const rejected = await server.instance.inject({
        method: "POST",
        url: "/workspaces/workspace/plugin/event",
        headers,
        payload: { type: "test.event" },
      })
      assert.equal(rejected.statusCode, 401)
    }

    const callback = await server.instance.inject({
      method: "POST",
      url: "/workspaces/workspace/plugin/event",
      headers: { authorization: "Bearer callback-secret" },
      payload: { type: "test.event" },
    })
    assert.equal(callback.statusCode, 204)

    const noncanonicalCallback = await server.instance.inject({
      method: "POST",
      url: "/workspaces/workspace/plugin//event",
      headers: { cookie: "session=valid" },
      payload: { type: "test.event" },
    })
    assert.equal(noncanonicalCallback.statusCode, 404)

    const trustedSsePending = server.instance.inject({
      method: "GET",
      url: "/api/events?clientId=trusted&connectionId=trusted",
      headers: { cookie: "session=valid", origin: "http://localhost:3000" },
    })
    const hostileSsePending = server.instance.inject({
      method: "GET",
      url: "/api/events?clientId=hostile&connectionId=hostile",
      headers: { cookie: "session=valid", origin: "https://attacker.example" },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await server.stop()
    const [trustedSse, hostileSse] = await Promise.all([trustedSsePending, hostileSsePending])
    assert.equal(trustedSse.headers["access-control-allow-origin"], "http://localhost:3000")
    assert.equal(trustedSse.headers["access-control-allow-credentials"], "true")
    assert.equal(hostileSse.headers["access-control-allow-origin"], undefined)
  } finally {
    if (server.instance.server.listening) await server.stop()
  }
})
