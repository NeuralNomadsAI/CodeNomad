export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/version.json") {
      const response = await env.ASSETS.fetch(request)

      const newHeaders = new Headers(response.headers)
      newHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
      newHeaders.set("Pragma", "no-cache")
      newHeaders.set("Expires", "0")

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      })
    }

    return env.ASSETS.fetch(request)
  },
}
