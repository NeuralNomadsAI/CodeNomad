import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http, { type IncomingMessage } from "node:http"
import type { TestContext } from "node:test"
import Fastify from "fastify"
import { RemoteServerBrowseManager } from "../browse-manager"
import { CodeNomadServerCredentials, type CodeNomadServerSecret } from "../credentials"
import { startFakeCodeNomad } from "./fake-codenomad"
import { registerBackendRelayRoutes } from "../../server/routes/backend-relay"
import { registerRequestLogging } from "../../server/request-logging"
import type { Logger } from "../../logger"

export const PREFIX = "/api/backends/saved"

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

export async function bounded<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Relay did not progress within ${ms}ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

export function open(origin: string, target: string, options: { method?: string; headers?: http.OutgoingHttpHeaders } = {}) {
  const received = deferred<IncomingMessage>()
  const headers = Object.fromEntries(Object.entries({ origin, ...options.headers }).filter(([, value]) => value !== undefined))
  // Pass the path verbatim so routing tests can exercise raw targets.
  const request = http.request(new URL(origin), { path: target, method: options.method ?? "GET", agent: false,
    headers }, received.resolve)
  request.once("error", received.reject)
  // Some tests intentionally destroy the caller before headers.
  void received.promise.catch(() => {})
  return { request, response: received.promise }
}

export async function read(response: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk))
  return { status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }
}

export async function send(origin: string, target: string, options: Parameters<typeof open>[2] & { body?: string } = {}, ms?: number) {
  const socket = open(origin, target, options)
  socket.request.end(options.body)
  return bounded(socket.response.then(read), ms)
}

export async function relayFixture(t: TestContext, options: {
  remoteOrigin?: string
  remote?: Awaited<ReturnType<typeof startFakeCodeNomad>>
  secret?: CodeNomadServerSecret | null
  advertised?: string[]
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-relay-"))
  const remote = options.remote ?? await startFakeCodeNomad()
  const profiles = [{ id: "saved", baseUrl: options.remoteOrigin ?? remote.origin, skipTlsVerify: false }]
  const file = path.join(directory, "remote-server-credentials.json")
  if (options.secret) new CodeNomadServerCredentials(file).set("saved", profiles[0]!.baseUrl, options.secret)
  const settings = { getOwner: () => ({ remoteServers: profiles }), configYamlPathForAuthority: () => path.join(directory, "config.yaml") }
  const manager = new RemoteServerBrowseManager(settings)
  const app = Fastify()
  const logs: unknown[] = []
  registerRequestLogging(app, { debug: (record: unknown) => logs.push(record), trace: (record: unknown) => logs.push(record), isLevelEnabled: () => true } as unknown as Logger)
  t.after(async () => {
    manager.close()
    app.server.closeAllConnections()
    await app.close()
    await remote.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  let origin = ""
  registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => new Set([origin, ...(options.advertised ?? [])]) })
  origin = await app.listen({ host: "127.0.0.1", port: 0 })
  return { remote, manager, settings, app, origin, profiles, file, logs }
}
