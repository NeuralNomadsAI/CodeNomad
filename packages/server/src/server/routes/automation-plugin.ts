import { timingSafeEqual } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { AuthManager } from "../../auth/manager"
import type { DeveloperCdp } from "../../developer-cdp"
import type { NativeParent } from "../../native-parent"
import { AUTOMATION_BRIDGE_PATH, parseDeveloperAction } from "../../opencode/automation-plugin"
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
    cdpUrl?: string
    targetId?: string
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
  let developerOwner: { runId: string; sessionID: string } | undefined
  app.post(AUTOMATION_BRIDGE_PATH, { bodyLimit: 32 * 1024 }, async (request, reply) => {
    if (!isAutomationPluginRequest(request, deps)) return reply.code(401).send({ error: "Unauthorized automation bridge" })
    const body = request.body as { mode?: unknown; directory?: unknown; workspaceID?: unknown; sessionID?: unknown; command?: unknown } | undefined
    if (body?.mode === "location") {
      if (typeof body.directory !== "string" || body.directory.length === 0 || body.directory.length > 32_768) {
        return reply.code(400).send({ error: "Invalid automation bridge location" })
      }
      if (body.workspaceID !== undefined && (typeof body.workspaceID !== "string" || body.workspaceID.length === 0 || body.workspaceID.length > 256)) {
        return reply.code(400).send({ error: "Invalid automation bridge workspace" })
      }
      const directory = body.directory
      const workspaceID = body.workspaceID as string | undefined
      const owned = await Promise.all(deps.workspaceManager.list().map((workspace) =>
        deps.workspaceManager.ownsLocation(workspace.id, { directory, workspaceID }),
      ))
      if (owned.some(Boolean)) return reply.send({ result: { available: true } })
      return reply.code(404).send({ error: "Location is not owned by this CodeNomad instance" })
    }
    if (!body || !["developer-probe", "developer-execute"].includes(String(body.mode))
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

    let native: DeveloperNativeStatus
    try {
      native = await deps.nativeParent.request<DeveloperNativeStatus>("developer.status", {})
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) })
    }
    const status = native.status
    const available = status?.state !== "stopped" && typeof status.runId === "string"
    if (!available) {
      if (developerOwner) deps.developerCdp.close(developerOwner.runId)
      developerOwner = undefined
    } else if (developerOwner?.runId !== status.runId) {
      if (developerOwner) deps.developerCdp.close(developerOwner.runId)
      developerOwner = { runId: status.runId!, sessionID: body.sessionID }
    }
    if (developerOwner && developerOwner.sessionID !== body.sessionID) {
      return reply.code(409).send({ error: "Developer Automation is owned by another session" })
    }
    if (body.mode === "developer-probe") {
      return available
        ? reply.send({ result: { available: true } })
        : reply.code(404).send({ error: "Developer Automation is not running" })
    }

    let command
    try {
      command = parseDeveloperAction(body.command)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
    try {
      if (command.action === "restart") {
        const previousRunId = status.runId
        const result = await deps.nativeParent.request<DeveloperNativeStatus["status"]>("developer.restart", {})
        if (previousRunId) deps.developerCdp.close(previousRunId)
        if (typeof result.runId === "string") developerOwner = { runId: result.runId, sessionID: body.sessionID }
        return reply.send({ result })
      }
      if (!available || status.state !== "ready" || typeof status.runId !== "string"
        || typeof status.cdpUrl !== "string" || typeof status.targetId !== "string") {
        return reply.code(409).send({ error: "Developer Automation is not ready" })
      }
      if (command.action === "inspect") {
        const inspection = await deps.developerCdp.inspect({ endpoint: status.cdpUrl, runId: status.runId, targetId: status.targetId })
        return reply.send({ result: { ...inspection, logs: native.logs?.slice(-200) ?? [] } })
      }
      if (command.action === "screenshot") {
        const image = await deps.developerCdp.screenshot(status.runId)
        return reply.send({ result: { image: { data: image.data, mime: image.mediaType } } })
      }
      await deps.developerCdp.act(command.action === "type"
        ? { runId: status.runId, kind: "type", ref: command.ref, text: command.text }
        : { runId: status.runId, kind: "click", ref: command.ref })
      return reply.send({ result: { ok: true } })
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
