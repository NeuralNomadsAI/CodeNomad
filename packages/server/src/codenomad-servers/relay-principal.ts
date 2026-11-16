import type { FastifyReply, FastifyRequest } from "fastify"
import type { AuthManager } from "../auth/manager"
import type { RemoteControlManager } from "../remote-control/manager"

/** One admitted remote request retains its original principal through dispatch and publication. */
export function createRelayPrincipalBinding(deps: {
  auth: AuthManager
  devices: Pick<RemoteControlManager, "isDeviceAuthorized">
  local(request: FastifyRequest): boolean
}) {
  return (request: FastifyRequest, reply: FastifyReply): AbortSignal | undefined => {
    if (deps.local(request)) return undefined
    const principal = deps.auth.getSessionFromRequest(request)
    if (!principal) {
      reply.header("connection", "close").code(401).send({ error: "auth" })
      return AbortSignal.abort()
    }
    const controller = new AbortController()
    let active = true
    let releaseSession = () => {}
    let deviceTimer: ReturnType<typeof setInterval> | undefined
    const release = () => {
      if (!active) return
      active = false
      clearInterval(deviceTimer)
      releaseSession()
      request.raw.off("aborted", abort)
      reply.raw.off("close", abort)
      reply.raw.off("finish", release)
    }
    const abort = () => {
      if (!active) return
      controller.abort()
      reply.raw.destroy()
      release()
    }
    request.raw.once("aborted", abort)
    reply.raw.once("close", abort)
    reply.raw.once("finish", release)
    if (principal.sessionId.startsWith("remote-device:")) {
      const id = principal.sessionId.slice("remote-device:".length)
      // Device socket revocation closes immediately; this read-only check also covers idle expiry.
      const check = () => { if (!deps.devices.isDeviceAuthorized(id)) abort() }
      check()
      if (active) { deviceTimer = setInterval(check, 250); deviceTimer.unref() }
    } else {
      releaseSession = deps.auth.onSessionInvalidated(principal.sessionId, abort)
    }
    return controller.signal
  }
}
