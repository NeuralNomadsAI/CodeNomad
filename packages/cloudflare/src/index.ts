export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

function withHeader(response: Response, key: string, value: string): Response {
  const headers = new Headers(response.headers)
  headers.set(key, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/version.json") {
      const assetResponse = await env.ASSETS.fetch(request)

      // Ensure this stays fresh; the server uses it on startup.
      const withCache = withHeader(assetResponse, "Cache-Control", "no-cache")
      return withHeader(withCache, "Content-Type", "application/json; charset=utf-8")
    }

    return new Response("Not found", { status: 404 })
  },
}
