import { isFormNotFoundError, isPermissionNotFoundError, type OpenCodeClient } from "@opencode/client"

type Session = Awaited<ReturnType<OpenCodeClient["session"]["get"]>>
type Refusal = { status: number; error: string }
type Request = { method: string; pathname: string; body: unknown; session: Session; client: OpenCodeClient; signal: AbortSignal }

export function controlKind(method: string, pathname: string) {
  if (method === "POST" && /^\/api\/session\/[^/]+\/interrupt\/?$/.test(pathname)) return "interrupt"
  if (method === "POST" && /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply\/?$/.test(pathname)) return "permission"
  if ((method === "POST" && /^\/api\/session\/[^/]+\/form\/[^/]+\/reply\/?$/.test(pathname))
    || (method === "DELETE" && /^\/api\/session\/[^/]+\/form\/[^/]+\/?$/.test(pathname))) return "form"
}

/** Native pending identity and bounded decision validation, independent of receipt storage. */
export async function admitSessionControl(input: Request): Promise<Refusal | undefined> {
  const kind = controlKind(input.method, input.pathname)
  if (!kind) return
  const body = input.body === undefined ? {} : input.body
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, error: "Invalid session control" }
  const value = body as Record<string, unknown>
  if (kind === "interrupt") {
    if (Object.keys(value).some(k => k !== "resume") || (value.resume !== undefined && typeof value.resume !== "boolean")) {
      return { status: 400, error: "Invalid interruption request" }
    }
    return
  }
  if (kind === "permission" && (Object.keys(value).some(k => k !== "decision" && k !== "message")
    || !["once", "always", "reject"].includes(String(value.decision))
    || (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 4096)))) {
    return { status: 400, error: "Invalid permission decision" }
  }
  if (kind === "form" && input.method === "POST" && Object.keys(value).some(k => k !== "answer")) {
    return { status: 400, error: "Invalid question reply" }
  }
  const missing = { status: 409, error: kind === "permission"
    ? "Permission is no longer pending for this session" : "Question is no longer pending for this session" }
  const parts = input.pathname.replace(/\/$/, "").split("/")
  let id: string
  try { id = decodeURIComponent(parts[kind === "permission" || input.method === "POST" ? parts.length - 2 : parts.length - 1]) }
  catch { return { status: 400, error: "Invalid request ID" } }
  try {
    const options = { signal: AbortSignal.any([input.signal, AbortSignal.timeout(5000)]) }
    if (kind === "permission") {
      const pending = await input.client.permission.get({ sessionID: input.session.id, requestID: id }, options)
      if (pending.id !== id || pending.sessionID !== input.session.id) return missing
    } else {
      const pending = await input.client.session.form.get({ sessionID: input.session.id, formID: id }, options)
      if (pending.id !== id || pending.sessionID !== input.session.id || pending.state.status !== "pending") return missing
    }
  } catch (error) {
    if (isFormNotFoundError(error) || isPermissionNotFoundError(error)) return missing
    input.signal.throwIfAborted()
    return { status: 502, error: "Workspace instance proxy failed" }
  }
}

/** Revalidate after pending/receipt reads and immediately before native forwarding. */
export async function currentSessionControl(input: Request): Promise<boolean> {
  if (!controlKind(input.method, input.pathname)) return true
  const fresh = await input.client.session.get({ sessionID: input.session.id }, {
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(5000)]),
  })
  const identity = (s: Session) => JSON.stringify([s.id, s.location, s.projectID, s.parentID, s.fork, s.time?.created])
  return identity(fresh) === identity(input.session)
}
