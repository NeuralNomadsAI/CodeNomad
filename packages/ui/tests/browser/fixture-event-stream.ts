import { createServer } from "node:http"
import type { Page } from "playwright"

/** A quiet, persistent SSE connection for fixtures dispatching native events locally. */
export async function fixtureEventStream(origin: string) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": new URL(origin).origin, "Access-Control-Allow-Credentials": "true" })
    response.write(": fixture events use the real local dispatcher\n\n")
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/events`
  return {
    route: (page: Page) => page.route("**/api/events*", route => route.continue({ url })),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
