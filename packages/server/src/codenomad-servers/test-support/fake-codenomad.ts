import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http"
import { createServer as createHttpsServer, type ServerOptions } from "node:https"

export type RecordedRequest = { method: string; path: string; headers: IncomingHttpHeaders; body: string }

/** A real direct-listener HTTP(S) remote, with expirable authentication and bounded browsing routes. */
export async function startFakeCodeNomad(options: { password?: string; root?: string; tls?: ServerOptions; anonymous?: boolean } = {}) {
  const state = {
    password: options.password ?? "remote-password", sessions: new Set<string>(), logins: 0,
    requests: [] as RecordedRequest[],
    overrides: new Map<string, { status: number; body: unknown; headers?: Record<string, string> }>(),
    recents: [{ path: "/srv/projects/app", projectName: "App", lastAccessed: 42, password: "must-not-leak" }],
  }
  const root = options.root ?? "/srv/projects"
  const listener: RequestListener = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake")
    let body = ""
    for await (const chunk of request) body += chunk
    state.requests.push({ method: request.method!, path: `${url.pathname}${url.search}`, headers: request.headers, body })
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(value))
    }
    const override = state.overrides.get(url.pathname)
    if (override) return json(override.status, override.body, override.headers)
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      state.logins++
      const { username, password } = JSON.parse(body || "{}")
      if (username !== "codenomad" || password !== state.password) return json(401, { error: "Invalid credentials" })
      const session = randomUUID()
      state.sessions.add(session)
      return json(200, { ok: true }, { "set-cookie": `codenomad_session=${session}; HttpOnly; Path=/; SameSite=Lax` })
    }
    const cookies = Object.fromEntries((request.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map(pair => pair.split("=", 2) as [string, string]))
    const authenticated = options.anonymous || state.sessions.has(cookies.codenomad_session ?? "")
    if (url.pathname === "/api/auth/status") return json(200, { authenticated })
    if (!authenticated) return json(401, { error: "Unauthorized" })
    if (url.pathname === "/api/storage/state/ui") return json(200, { recentFolders: state.recents, password: "must-not-leak" })
    if (url.pathname === "/api/filesystem") {
      const relative = url.searchParams.get("path") ?? "."
      const current = relative.startsWith(root) ? relative.slice(root.length).replace(/^\//, "") || "." : relative
      return json(200, {
        entries: [{ name: "app", path: current === "." ? "app" : `${current}/app`, absolutePath: `${root}/${current === "." ? "" : `${current}/`}app`, type: "directory", password: "must-not-leak" },
          { name: "README.md", path: "README.md", type: "file" }],
        metadata: { scope: "restricted", currentPath: current, ...(current === "." ? {} : { parentPath: "." }), rootPath: root, homePath: root,
          displayPath: current === "." ? root : `${root}/${current}`, pathKind: "relative", password: "must-not-leak" },
      })
    }
    json(404, { error: "Not found" })
  }
  const server = options.tls ? createHttpsServer(options.tls, listener) : createServer(listener)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `${options.tls ? "https" : "http"}://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    origin, state,
    restart() { state.sessions.clear() },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
