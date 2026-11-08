import { getSetCookies, Headers } from "undici"
import { createExplicitTransport } from "../opencode/servers/transport"
import { DEVICE_COOKIE_NAME } from "../remote-control/gate"
import { CodeNomadServerClient, CodeNomadServerError } from "./client"
import type { CodeNomadServerSecret } from "./credentials"

export interface RemoteViewCookie {
  origin: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: "lax" | "strict" | "none"
  expires?: number
}

/** Disposable transport: passwords stay here; the browse session and credential file stay untouched. */
export async function createViewSession(origin: string, skipTlsVerify: boolean, secret: CodeNomadServerSecret | undefined,
  signal: AbortSignal): Promise<{ cookie?: RemoteViewCookie }> {
  if (!secret) {
    const client = new CodeNomadServerClient(origin, undefined, { skipTlsVerify })
    try {
      const status = await client.json<{ authenticated?: unknown; pairingRequired?: unknown }>("/api/auth/status", { signal })
      if (status.status !== 200) throw new CodeNomadServerError("unreachable")
      if (status.body?.authenticated !== true || status.body.pairingRequired) throw new CodeNomadServerError("needs_credentials")
      return {}
    } finally { client.close() }
  }
  if (secret.kind === "session") throw new CodeNomadServerError("needs_credentials")
  if (secret.kind === "device") {
    const client = new CodeNomadServerClient(origin, secret, { skipTlsVerify })
    try {
      const status = await client.json<{ authenticated?: boolean; pairingRequired?: boolean }>("/api/auth/status", { signal })
      if (status.status !== 200) throw new CodeNomadServerError("unreachable")
      if (!status.body?.authenticated || status.body.pairingRequired) throw new CodeNomadServerError("needs_credentials")
      const match = new RegExp(`^${DEVICE_COOKIE_NAME}=([A-Za-z0-9_-]{43})$`).exec(secret.cookie)
      if (!match || !origin.startsWith("https:")) throw new CodeNomadServerError("needs_credentials")
      return { cookie: { origin, name: DEVICE_COOKIE_NAME, value: match[1]!, path: "/", secure: true, httpOnly: true, sameSite: "lax" } }
    } finally { client.close() }
  }
  const headers = new Headers()
  const transport = createExplicitTransport({ origin, skipTlsVerify, signal,
    onSetCookie: values => { for (const value of values) headers.append("set-cookie", value) } })
  const response = await transport.fetch(new URL("/api/auth/login", origin), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: secret.username, password: secret.password }), signal: AbortSignal.timeout(10_000),
  })
  await response.body?.cancel().catch(() => {})
  if ([400, 401, 403].includes(response.status)) throw new CodeNomadServerError("auth")
  if (!response.ok) throw new CodeNomadServerError("unreachable")
  // CodeNomad permits a configured session-cookie name. Login issues one HttpOnly session.
  const cookies = getSetCookies(headers).filter(cookie => cookie.httpOnly)
  const cookie = cookies.length === 1 ? cookies[0] : undefined
  if (!cookie?.value || (cookie.domain && cookie.domain.replace(/^\./, "") !== new URL(origin).hostname)) throw new CodeNomadServerError("unreachable")
  const expires = cookie.maxAge !== undefined ? Math.floor(Date.now() / 1000) + cookie.maxAge
    : cookie.expires instanceof Date ? Math.floor(cookie.expires.getTime() / 1000) : undefined
  if (expires !== undefined && (!Number.isFinite(expires) || expires <= Date.now() / 1000)) throw new CodeNomadServerError("auth")
  return { cookie: { origin, name: cookie.name, value: cookie.value, path: cookie.path ?? "/", secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly), sameSite: cookie.sameSite?.toLowerCase() as RemoteViewCookie["sameSite"] ?? "lax",
    ...(expires === undefined ? {} : { expires }) } }
}
