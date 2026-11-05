import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { OpenCode, type OpenCodeClient, type LocationRef } from "@opencode/client"
import Fastify from "fastify"
import pino from "pino"
import type { TestContext } from "node:test"
import { EventBus } from "../../events/bus"
import { explicitContractFixture } from "../../opencode/compatibility/contract-fixture"
import { OpenCodeServerConnections } from "../../opencode/servers/connections"
import { OpenCodeServerCredentials } from "../../opencode/servers/credentials"
import { OpenCodeServerRegistry } from "../../opencode/servers/registry"
import type { ServerCapability } from "../../opencode/servers/capabilities"
import { mediaDigest } from "../../opencode/session-media"
import { WorkspaceManager } from "../../workspaces/manager"
import { registerSessionMediaRoutes } from "./session-media"

export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64")
export const imageUri = `data:image/png;base64,${png.toString("base64")}`
export const nativeMessage = (uri = imageUri, mime = "image/png") => ({ id: "m", type: "assistant", content: [
  { type: "tool", state: { status: "completed", content: [{ type: "file", mime, uri }] } },
] })
export function latch() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Owned loopback HTTP only; real registry/credentials/transport/manager and official client. */
export async function mediaFixture(t: TestContext) {
  const directory = "/opaque Case/🦊", calls: { target: string; path: string; auth?: string; directory?: string }[] = []
  let session: Record<string, unknown> = { id: "s", location: { directory } }
  let file = nativeMessage(), responder: ((response: ServerResponse) => void) | undefined
  let sessionResponder: ((response: ServerResponse) => void) | undefined
  let afterMessage = () => {}
  const upstreams: ReturnType<typeof createServer>[] = [], profiles: any[] = []
  let localConnection: any
  for (const target of ["A", "B", "local-shared"]) {
    const upstream = createServer((request, response) => {
      const url = new URL(request.url!, "http://fixture")
      calls.push({ target, path: url.pathname, auth: request.headers.authorization, directory: request.headers["x-opencode-directory"] as string | undefined })
      response.setHeader("content-type", "application/json")
      const send = (value: unknown) => response.end(JSON.stringify(value))
      if (url.pathname === "/openapi.json") return send(explicitContractFixture())
      if (url.pathname === "/api/location") return send({ directory, project: { id: "same", directory: "/", canonical: "/" } })
      if (url.pathname === "/api/fs/list") return send({ location: { directory }, data: [] })
      if (url.pathname === "/api/session/s") return sessionResponder ? sessionResponder(response) : send({ data: session })
      if (url.pathname === "/api/session/s/message/m") {
        afterMessage()
        return responder ? responder(response) : send({ data: target === "B" ? nativeMessage(`data:image/png;base64,${Buffer.from("B").toString("base64")}`) : file })
      }
      response.statusCode = 404; send({})
    })
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening")
    upstreams.push(upstream)
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
    if (target !== "local-shared") profiles.push({ id: target, kind: "explicit", label: target, origin })
    else localConnection = { endpoint: { url: origin, username: "fixture", password: "local-fixture" },
      fetch: globalThis.fetch, client: OpenCode.make({ baseUrl: origin }), assertCurrent() {}, invalidate() {}, profile: async () => "modern" }
  }
  const forbidden = () => { throw new Error("Host operation forbidden") }
  const registry = new OpenCodeServerRegistry(() => profiles, forbidden)
  const credentials = new OpenCodeServerCredentials({ profileKey: "media", configIdentity: "media" }, registry)
  for (const id of ["A", "B"]) await credentials.set(id, JSON.stringify({ username: id, password: `fixture-${id}` }))
  const connections = new OpenCodeServerConnections({ registry, credentials, local: { acquire: forbidden, existing: forbidden, invalidate: forbidden } })
  const manager = new WorkspaceManager({ rootDir: "C:/forbidden", eventBus: new EventBus(), logger: pino({ level: "silent" }),
    binaryResolver: { resolveDefault: forbidden } as never,
    settings: { getOpenCodeServerConnections: () => connections, getOwner: forbidden, readEnvironmentForAdmission: forbidden,
      disposeOpenCodeServers: () => connections.dispose() } as never,
    sharedService: { endpoint: forbidden, client: forbidden, headers: forbidden, validateLocation: forbidden, subscribe: forbidden, shutdown: async () => {} },
  })
  const a = (await manager.create(directory, undefined, { serverId: "A" })).workspace
  const b = (await manager.create(directory, undefined, { serverId: "B" })).workspace
  const local = { id: "local", path: directory, binding: { serverId: "local-shared", directory } } as typeof a
  const localLife = new AbortController()
  const get = manager.get.bind(manager), acquire = manager.getSharedServiceConnection.bind(manager), requireCapability = manager.requireWorkspaceCapability.bind(manager)
  const owns = manager.ownsLocation.bind(manager)
  t.mock.method(manager, "get", (id: string) => id === local.id ? local : get(id))
  t.mock.method(manager, "getSharedServiceConnection", (id: string) => id === local.id ? Promise.resolve(localConnection) : acquire(id))
  t.mock.method(manager, "requireWorkspaceCapability", (id: string, capability: ServerCapability) => id === local.id ? localLife.signal : requireCapability(id, capability))
  t.mock.method(manager, "ownsLocation", (id: string, location: LocationRef, client?: OpenCodeClient, signal?: AbortSignal) => id === local.id ? Promise.resolve(location.directory === directory) : owns(id, location, client, signal))
  t.mock.method(manager, "getSharedServiceClient", forbidden)
  const app = Fastify()
  registerSessionMediaRoutes(app, { workspaceManager: manager })
  t.after(async () => {
    await manager.shutdown()
    await app.close()
    await Promise.all(upstreams.map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) }))
  })
  const url = (id = a.id, uri = imageUri, part = "0", index = "0") => `/api/workspaces/${id}/session-media/s/m/${part}/${index}/${mediaDigest(uri)}`
  return { app, manager, connections, credentials, calls, a, b, local, localLife, url,
    message(value: typeof file) { file = value }, session(value: typeof session) { session = value },
    respond(value?: typeof responder) { responder = value }, respondSession(value?: typeof sessionResponder) { sessionResponder = value },
    afterMessage(value: () => void) { afterMessage = value },
  }
}
