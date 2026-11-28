import { createServer, type ServerResponse } from "node:http"
import type { Page } from "playwright"
import type { WorkspaceEventPayload } from "../../../server/src/api-types"

/** A persistent SSE connection, quiet unless the fixture sends events. */
export async function fixtureEventStream(origin: string) {
  const clients = new Set<ServerResponse>()
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": new URL(origin).origin, "Access-Control-Allow-Credentials": "true" })
    response.write(": fixture events use the real local dispatcher\n\n")
    clients.add(response)
    response.once("close", () => clients.delete(response))
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/events`
  return {
    url,
    send: (event: WorkspaceEventPayload) => {
      for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    route: (page: Page) => page.route(request => request.pathname === "/api/events", route => route.continue({ url })),
    disconnect: () => server.closeAllConnections(),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
