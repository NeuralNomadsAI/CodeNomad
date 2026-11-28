import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AuthManager } from "../../auth/manager"
import { LoginStartError, type OpenCodeLoginStart } from "../../host-lifetime/opencode-login-start"
import type { RemoteControlManager } from "../../remote-control/manager"
import { isRemoteRequest, remoteDeviceOf } from "../../remote-control/request-origin"

// AuthManager names a paired device session `remote-device:<id>`; login cookie
// session IDs are base64url and can never take this form.
const REMOTE_DEVICE_SESSION = "remote-device:"
type Deps = { auth: Pick<AuthManager, "isAuthEnabled" | "getSessionFromRequest">
  /** Live Remote Control device authorization; absent means no paired device qualifies. */
  remoteDevices?: Pick<RemoteControlManager, "isDeviceAuthorized">
  loginStart: Pick<OpenCodeLoginStart, "read" | "set"> }

/** The authenticated human behind the request, revalidated on every check: a live
 * login cookie session (auth enabled) or, from the Remote Control ingress only
 * (socket membership, never a header), a paired device that is still authorized. */
function humanSession(request: FastifyRequest, deps: Deps): { username: string; sessionId: string } | undefined {
  const session = deps.auth.getSessionFromRequest(request)
  if (!deps.auth.isAuthEnabled() || !session || session.sessionId === "auth-disabled") return undefined
  if (isRemoteRequest(request)) {
    const deviceID = remoteDeviceOf(request)
    return deviceID && session.sessionId === `${REMOTE_DEVICE_SESSION}${deviceID}`
      && deps.remoteDevices?.isDeviceAuthorized(deviceID) === true ? session : undefined
  }
  return session.sessionId.startsWith(REMOTE_DEVICE_SESSION) ? undefined : session
}
const controlSchema = z.object({ enabled: z.boolean() }).strict()
const status = { unavailable: 503, "unsupported-binary": 422, failed: 500 } as const

/** Changing what the OS starts at login requires a live human session. */
export function registerOpenCodeLoginStartRoutes(app: FastifyInstance, deps: Deps) {
  const reply = (error: unknown) => {
    const code = error instanceof LoginStartError ? error.code : "failed"
    return { code: status[code], body: { error: `login-start-${code}` } }
  }
  app.get("/api/opencode/login-start", async (_request, response) => {
    try { return await deps.loginStart.read() } catch (error) {
      const failure = reply(error)
      return response.code(failure.code).send(failure.body)
    }
  })
  app.post("/api/opencode/login-start", async (request, response) => {
    const body = controlSchema.safeParse(request.body)
    if (!body.success) return response.code(400).send({ error: "login-start-input-invalid" })
    if (!humanSession(request, deps)) return response.code(401).send({ error: "login-start-human-required" })
    try { return await deps.loginStart.set(body.data.enabled) } catch (error) {
      const failure = reply(error)
      return response.code(failure.code).send(failure.body)
    }
  })
}
