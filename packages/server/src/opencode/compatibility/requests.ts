// Only translate consumed, reviewed operations. The external proxy allowlist is
// checked before reaching this module; translation never expands that allowlist.
export function legacyRequest(url: URL, method: string, body: Record<string, unknown> | undefined) {
  const original = url.pathname
  if (original === "/api/status" && method === "GET") url.pathname = "/api/health"
  if (/^\/api\/experimental\/session\/(?:stats|import|[^/]+\/(?:export|wait|instructions\/entries(?:\/[^/]+)?))$/.test(original)
    || /^\/api\/experimental\/mcp\/[^/]+\/(?:connect|disconnect)$/.test(original)) {
    url.pathname = original.replace("/experimental", "")
  }
  if (original === "/api/form" && method === "GET") url.pathname = "/api/form/request"
  if (/^\/api\/session\/[^/]+$/.test(original) && method === "PATCH") {
    if (!body || typeof body.title !== "string" || Object.keys(body).some(key => key !== "title")) {
      throw new Error("Earlier OpenCode V2 supports title-only session updates")
    }
    url.pathname += "/rename"
    method = "POST"
  }
  if (/^\/api\/session\/[^/]+\/fork$/.test(original) && method === "POST") {
    if (body?.before !== undefined && typeof body.before !== "string") throw new Error("Invalid fork boundary")
    body = { boundary: body?.before === undefined ? { type: "through" } : { type: "before", messageID: body.before } }
  }
  if (/^\/api\/session\/[^/]+\/command$/.test(original) && method === "POST" && body) {
    const { name, ...rest } = body
    body = { ...rest, command: name }
  }
  if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(original) && method === "POST" && body) {
    const { decision, ...rest } = body
    body = { ...rest, reply: decision }
  }
  if (/^\/api\/session\/[^/]+\/interrupt$/.test(original) && method === "POST" && url.searchParams.has("resume")) {
    url.searchParams.set("continue", url.searchParams.get("resume")!)
    url.searchParams.delete("resume")
  }
  if (/^\/api\/session\/[^/]+\/inbox\/[^/]+$/.test(original) && method === "PATCH") {
    if (body?.delivery !== "steer" && body?.delivery !== "queue") throw new Error("Invalid inbox delivery")
    url.pathname += `/${body.delivery}`
    method = "POST"
    body = undefined
  }
  if (/^\/api\/session\/[^/]+\/revert$/.test(original) && method === "DELETE") {
    url.pathname += "/clear"
    method = "POST"
  }
  if (/^\/api\/session\/[^/]+\/form\/[^/]+$/.test(original) && method === "DELETE") {
    url.pathname += "/cancel"
    method = "POST"
  }
  return { url, method, body }
}
