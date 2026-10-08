import { timingSafeEqual } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { AuthManager } from "../../auth/manager"
import type { DeveloperCdp } from "../../developer-cdp"
import type { DeveloperCdpIdentity, DeveloperCdpSelection } from "../../developer-cdp"
import type { NativeParent } from "../../native-parent"
import { AUTOMATION_BRIDGE_PATH, parseBrowserAction, parseDeveloperAction } from "../../opencode/automation-plugin"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { admitMissionInput } from "./mission-input"
import { createManagedMissionRoot } from "./mission-root-creation"
import { requestAdmission } from "../request-admission"
import { MissionCreationHoldError } from "./mission-creation-holds"
import { DeveloperInspectionTargets } from "../../automation/developer-inspection-targets"
import { missionRecoveryRejection } from "../../missions/recovery-error"
import { verifyMissionHumanAnswer } from "./mission-human-answer"
import { verifyHumanRecurrenceRequest } from "./mission-recurrence-proof"
import type { SettingsService } from "../../settings/service"

interface AutomationPluginRouteDeps {
  authManager: AuthManager
  bridgeToken: string
  nativeParent: NativeParent
  workspaceManager: WorkspaceManager
  developerCdp: DeveloperCdp
  worktreeDeletionFence?: WorktreeDeletionFence
  settings?: Pick<SettingsService, "getProfileScope">
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
  const inspectedTargets = new DeveloperInspectionTargets()
  app.post(AUTOMATION_BRIDGE_PATH, { bodyLimit: 512 * 1024 }, async (request, reply) => {
    const lifetime = requestAdmission(request, reply)
    try {
    if (!isAutomationPluginRequest(request, deps)) return reply.code(401).send({ error: "Unauthorized automation bridge" })
    const body = request.body as { mode?: unknown; sessionID?: unknown; command?: unknown } | undefined
    if (body?.mode === "human-answer-verify") {
      if (!deps.settings) return reply.code(503).send({ error: "Human answer admission unavailable" })
      try { return reply.send({ result: await verifyMissionHumanAnswer(body.command,
        { auth: deps.authManager, manager: deps.workspaceManager, settings: deps.settings }, lifetime.signal) }) }
      catch { return reply.code(403).send({ error: "Human answer admission unavailable" }) }
    }
    if (body?.mode === "recurrence-control-verify") {
      try {
        return reply.send({ result: await verifyHumanRecurrenceRequest(body.command, {
          auth: deps.authManager, manager: deps.workspaceManager, settings: deps.settings,
        }, lifetime.signal) })
      } catch { return reply.code(403).send({ error: "Recurrence human admission unavailable" }) }
    }
    if (!body || !["developer-probe", "developer-execute", "browser-claim", "browser-probe", "browser-execute", "mission-input"].includes(String(body.mode))
      || typeof body.sessionID !== "string" || body.sessionID.length > 256) {
      return reply.code(400).send({ error: "Invalid automation bridge request" })
    }
    const signal = body.mode === "mission-input"
      ? AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]) : lifetime.signal

    let location
    try {
      signal.throwIfAborted()
      const client = await lifetime.wait(deps.workspaceManager.getSharedServiceClient())
      signal.throwIfAborted()
      location = (await lifetime.wait(client.session.get({ sessionID: body.sessionID }, { signal }))).location
    } catch {
      return reply.code(404).send({ error: "Session not found" })
    }
    // One validated owner is sufficient. Waiting for every unrelated inventory
    // can exceed the plugin's discovery deadline despite a ready local owner.
    const owned = await lifetime.wait(Promise.any(deps.workspaceManager.list().map(async workspace => {
      if (!await deps.workspaceManager.ownsLocation(workspace.id, location, undefined, signal)) throw new Error("Not an owner")
      return true
    }))).catch(() => false)
    if (!owned) return reply.code(404).send({ error: "Session is not owned by this CodeNomad instance" })

    if (body.mode === "mission-input") {
      if (!deps.worktreeDeletionFence) return reply.code(503).send({ error: "Mission dispatch unavailable" })
      try {
        // Desktop-only, journal-keyed creation capability. Durable admission
        // does not use this bridge or gain a new native API fallback.
        const creation = body.command && typeof body.command === "object" && "kind" in body.command && body.command.kind === "create-root"
        const result = creation
          ? await createManagedMissionRoot(deps.workspaceManager, deps.worktreeDeletionFence, body.sessionID, body.command, signal)
          : await admitMissionInput(deps.workspaceManager, deps.worktreeDeletionFence, body.sessionID, body.command, signal)
        return reply.send({ result })
      } catch (error) {
        if (error instanceof MissionCreationHoldError) {
          return reply.code(error.code === "creation-capacity" ? 503 : 409).send({ error: error.message, code: error.code })
        }
        // Native errors can contain environment snapshots or provider credentials.
        const recovery = missionRecoveryRejection(error)
        if (recovery) return reply.code(recovery.status).send({ error: recovery.message, code: recovery.code })
        return reply.code(502).send({ error: "Mission admission failed" })
      }
    }

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
      return reply.code(404).send({ error: "Native automation has no active CodeNomad session" })
    }

    const selection: DeveloperCdpSelection = {
      endpoint: status.cdpUrl!,
      runId: status.runId!,
      windowId: status.windowId!,
    }
    let command
    if (body.mode !== "developer-probe") {
      try {
        command = parseDeveloperAction(body.command)
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
      }
    }
    let identity: DeveloperCdpIdentity | undefined
    try {
      if (body.mode === "developer-probe" || command?.action === "inspect") {
        await deps.developerCdp.context(selection)
      } else {
        identity = inspectedTargets.get(body.sessionID, selection)
        await deps.developerCdp.context(identity)
      }
    } catch (error) {
      if (body.mode !== "developer-probe") inspectedTargets.forget(body.sessionID)
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) })
    }
    identity ??= selection
    if (body.mode === "developer-probe") {
      return reply.send({ result: { available: true, nativeIdentity: status.nativeIdentity, runId: status.runId } })
    }

    if (!command) return reply.code(400).send({ error: "Missing developer command" })
    try {
      if (command.action === "restart") {
        inspectedTargets.forget(body.sessionID)
        const result = await deps.nativeParent.request<DeveloperNativeStatus["status"]>("developer.restart", {})
        deps.developerCdp.close(status.runId)
        return reply.send({ result })
      }
      if (command.action === "inspect") {
        const result = await deps.developerCdp.inspect(identity)
        inspectedTargets.remember(body.sessionID, identity)
        return reply.send({ result })
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
    } finally { lifetime.dispose() }
  })
}
