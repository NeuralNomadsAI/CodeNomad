import { isFormNotFoundError, isPermissionNotFoundError, isSessionNotFoundError, type OpenCodeClient } from "@opencode/client"
import { readLocationRef } from "../opencode/compatibility/location"
import { permissionSnapshot, type PermissionSnapshot } from "../permissions/receipt-store"

type Session = Awaited<ReturnType<OpenCodeClient["session"]["get"]>>
type Refusal = { status: number; body: Record<string, string>; reconcile?: true }
type Permission = { request: PermissionSnapshot; decision: "once" | "always" | "reject"; message?: string }
type Request = { pathname: string; query: URLSearchParams; body: unknown }
type Owner = { session: Session; client: OpenCodeClient; signal: AbortSignal }

export function controlKind(method: string, pathname: string) {
  if (method === "POST" && /^\/api\/session\/[^/]+\/interrupt$/.test(pathname)) return "interrupt"
  if (method === "POST" && /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(pathname)) return "permission"
  if (method === "POST" && /^\/api\/session\/[^/]+\/form\/[^/]+\/reply$/.test(pathname)) return "formReply"
  if (method === "DELETE" && /^\/api\/session\/[^/]+\/form\/[^/]+$/.test(pathname)) return "formCancel"
}

const invalid = (message: string): Refusal => ({ status: 400, body: { error: message, message } })
const upstreamFailed = (): Refusal => ({ status: 502, body: { error: "Workspace instance proxy failed" } })
const boundedRead = (signal: AbortSignal) => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })

export async function admitSessionControl(kind: NonNullable<ReturnType<typeof controlKind>>, input: Request & Owner):
  Promise<Refusal | Permission | undefined> {
  const body = input.body === undefined ? {} : input.body
  if (!body || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) return invalid("Invalid session control")
  const value = body as Record<string, unknown>
  const fields = Object.keys(value)
  if (kind === "interrupt") {
    const resume = input.query.getAll("resume")
    if (fields.some(k => k !== "resume") || (value.resume !== undefined && typeof value.resume !== "boolean")
      || resume.length > 1 || resume.some(v => v !== "true" && v !== "false")) return invalid("Invalid interruption request")
    return
  }
  const id = input.pathname.split("/").at(kind === "formCancel" ? -1 : -2)!
  const sessionID = input.session.id
  const options = boundedRead(input.signal)
  if (kind === "permission") {
    const { decision, message } = value
    if (fields.some(k => k !== "decision" && k !== "message") || (decision !== "once" && decision !== "always" && decision !== "reject")
      || (message !== undefined && (typeof message !== "string" || message.length > 4096))) return invalid("Invalid permission decision")
    const missing: Refusal = { status: 404, reconcile: true, body: {
      _tag: "PermissionNotFoundError", requestID: id, message: "Permission is no longer pending for this session",
    } }
    try {
      const pending = await input.client.permission.get({ sessionID, requestID: id }, options)
      if (pending.id !== id || pending.sessionID !== sessionID) return missing
      const request = permissionSnapshot(pending)
      return request ? { request, decision, message } : upstreamFailed()
    } catch (error) {
      input.signal.throwIfAborted()
      return isPermissionNotFoundError(error) ? missing : upstreamFailed()
    }
  }
  if (fields.some(k => kind === "formCancel" || k !== "answer")) return invalid("Invalid question request")
  const message = "Question is no longer pending for this session"
  const missing: Refusal = { status: 404, reconcile: true, body: { _tag: "FormNotFoundError", id, message } }
  try {
    const pending = await input.client.session.form.get({ sessionID, formID: id }, options)
    if (pending.id !== id || pending.sessionID !== sessionID) return missing
    if (pending.state.status !== "pending") {
      return { status: 409, reconcile: true, body: { _tag: "FormAlreadySettledError", id, message } }
    }
  } catch (error) {
    input.signal.throwIfAborted()
    return isFormNotFoundError(error) ? missing : upstreamFailed()
  }
}

/** Revalidate after pending/receipt reads and immediately before native forwarding. */
export async function currentSessionControl({ session, client, signal }: Owner): Promise<boolean> {
  try {
    const fresh = await client.session.get({ sessionID: session.id }, boundedRead(signal))
    const identity = (s: Session) => JSON.stringify([s.id, readLocationRef(s.location),
      s.projectID, s.parentID, s.fork, s.time?.created])
    return identity(fresh) === identity(session)
  } catch (error) {
    if (isSessionNotFoundError(error)) return false
    throw error
  }
}
