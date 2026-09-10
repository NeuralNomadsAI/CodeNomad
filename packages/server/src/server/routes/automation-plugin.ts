import { timingSafeEqual } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { AuthManager } from "../../auth/manager"
import type { DeveloperCdp } from "../../developer-cdp"
import type { DeveloperCdpIdentity, DeveloperCdpSelection } from "../../developer-cdp"
import type { NativeParent } from "../../native-parent"
import { AUTOMATION_BRIDGE_PATH, parseBrowserAction, parseDeveloperAction } from "../../opencode/automation-plugin"
import type { WorkspaceManager } from "../../workspaces/manager"

interface AutomationPluginRouteDeps {
  authManager: AuthManager
  bridgeToken: string
  nativeParent: NativeParent
  workspaceManager: WorkspaceManager
  developerCdp: DeveloperCdp
}

interface DeveloperNativeStatus {
  status: {
    state: string
    runId?: string
    nativeIdentity?: string
    cdpUrl?: string
    windowId?: string
  }
  logs?: unknown[]
}

export function isAutomationPluginRequest(
  request: FastifyRequest,
  deps: Pick<AutomationPluginRouteDeps, "authManager" | "bridgeToken">,
): boolean {
  if (request.method !== "POST" || request.url.split("?")[0] !== AUTOMATION_BRIDGE_PATH) return false
  if (!deps.authManager.isLoopbackRequest(request)) return false
  const supplied = request.headers["x-codenomad-automation-token"]
  if (typeof supplied !== "string") return false
  const actual = Buffer.from(supplied)
  const expected = Buffer.from(deps.bridgeToken)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function registerAutomationPluginRoute(app: FastifyInstance, deps: AutomationPluginRouteDeps): void {
  app.post(AUTOMATION_BRIDGE_PATH, { bodyLimit: 32 * 1024 }, async (request, reply) => {
    if (!isAutomationPluginRequest(request, deps)) return reply.code(401).send({ error: "Unauthorized automation bridge" })
    const body = request.body as { mode?: unknown; sessionID?: unknown; command?: unknown } | undefined
    if (!body || !["developer-probe", "developer-execute", "browser-claim", "browser-probe", "browser-execute"].includes(String(body.mode))
      || typeof body.sessionID !== "string" || body.sessionID.length > 256) {
      return reply.code(400).send({ error: "Invalid automation bridge request" })
    }

    let location
    try {
      location = (await (await deps.workspaceManager.getSharedServiceClient()).session.get({ sessionID: body.sessionID })).location
    } catch {
      return reply.code(404).send({ error: "Session not found" })
    }
    const owned = (await Promise.all(deps.workspaceManager.list().map((workspace) =>
      deps.workspaceManager.ownsLocation(workspace.id, location),
    ))).some(Boolean)
    if (!owned) return reply.code(404).send({ error: "Session is not owned by this CodeNomad instance" })

    if (body.mode === "browser-claim") return reply.send({ result: { available: true } })
    if (body.mode === "browser-probe") {
      try {
        const result = await deps.nativeParent.request<{ available: boolean }>("browser.probe", { sessionID: body.sessionID })
        return result.available ? reply.send({ result }) : reply.code(404).send({ error: "No visible browser target" })
      } catch (error) {
        return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (body.mode === "browser-execute") {
      let command
      try {
        command = parseBrowserAction(body.command)
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
      }
      try {
        const result = await deps.nativeParent.request("browser.execute", { sessionID: body.sessionID, command })
        return reply.send({ result })
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) })
      }
    }

    let native: DeveloperNativeStatus
    try {
      native = await deps.nativeParent.request<DeveloperNativeStatus>("developer.status", {})
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) })
    }
    const status = native.status
    const available = status?.state === "ready" && typeof status.runId === "string"
      && typeof status.nativeIdentity === "string" && typeof status.cdpUrl === "string" && typeof status.windowId === "string"
    if (!available) {
      if (typeof status?.runId === "string") deps.developerCdp.close(status.runId)
      return reply.code(404).send({ error: "Developer Mode has no active CodeNomad session" })
    }

    const selection: DeveloperCdpSelection = {
      endpoint: status.cdpUrl!,
      runId: status.runId!,
      windowId: status.windowId!,
      sessionId: body.sessionID,
    }
    let context
    try {
      context = await deps.developerCdp.context(selection)
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) })
    }
    if (!await deps.workspaceManager.ownsLocation(context.instanceId, location)) {
      return reply.code(404).send({ error: "The visible CodeNomad workspace does not own this OpenCode session" })
    }
    const identity: DeveloperCdpIdentity = { ...selection, instanceId: context.instanceId }
    if (body.mode === "developer-probe") {
      return reply.send({ result: { available: true, nativeIdentity: status.nativeIdentity, runId: status.runId } })
    }

    let command
    try {
      command = parseDeveloperAction(body.command)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
    try {
      if (command.action === "restart") {
        const result = await deps.nativeParent.request<DeveloperNativeStatus["status"]>("developer.restart", {})
        deps.developerCdp.close(status.runId)
        return reply.send({ result })
      }
      if (command.action === "inspect") {
        return reply.send({ result: await deps.developerCdp.inspect(identity) })
      }
      if (command.action === "screenshot") {
        const image = await deps.developerCdp.screenshot(identity)
        return reply.send({ result: { image: { data: image.data, mime: image.mediaType } } })
      }
      await deps.developerCdp.act(command.action === "type"
        ? { ...identity, kind: "type", ref: command.ref, text: command.text }
        : { ...identity, kind: "click", ref: command.ref })
      return reply.send({ result: { ok: true } })
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
