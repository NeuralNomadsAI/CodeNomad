import { once } from "node:events"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { TestContext } from "node:test"
import { createBackendClient, registerBackendClient, type BackendClient } from "../../src/lib/backend-client"
import { backendEvents } from "../../src/lib/backend-events"

export function attachBackend(t: TestContext, backend: BackendClient) {
  const unregister = registerBackendClient(backend)
  let detach = backendEvents.attach(backend.id, backend.events)
  t.after(() => { detach(); backend.events.dispose(); unregister() })
  return { backend, unregister, detach: () => detach(),
    reattach: () => { detach = backendEvents.attach(backend.id, backend.events) } }
}

export async function loopbackBackend(t: TestContext, id: string,
  respond: (request: IncomingMessage, response: ServerResponse, body: string) => unknown) {
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    await respond(request, response, body)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const { port } = server.address() as { port: number }
  return attachBackend(t, createBackendClient({ id, baseUrl: `http://127.0.0.1:${port}` }))
}

export function requestWire(input: RequestInfo | URL, init?: RequestInit) {
  return { url: String(input), method: init?.method ?? "GET", body: init?.body,
    headers: [...new Headers(init?.headers)], credentials: init?.credentials }
}
