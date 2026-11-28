import { timingSafeEqual } from "node:crypto"
import { isSessionNotFoundError } from "@opencode/client"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { AuthManager } from "../../auth/manager"
import type { DeveloperCdp } from "../../developer-cdp"
import type { DeveloperCdpDiagnostic, DeveloperCdpIdentity, DeveloperCdpSelection } from "../../developer-cdp"
import { StaleDeveloperDocument } from "../../developer-cdp"
import { parseDeveloperTarget, type DeveloperTargetSelector } from "../../automation/developer-target-selector"
import { NativeRequestRefused, type NativeParent } from "../../native-parent"
import { AUTOMATION_BRIDGE_PATH, parseDeveloperAction } from "../../opencode/automation-plugin"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { admitMissionInput } from "./mission-input"
import { createManagedMissionRoot } from "./mission-root-creation"
import { prepareCoordinatorMission } from "./mission-prepare"
import { controlAgentMissionSchedule } from "./mission-agent-schedule"
import { controlAgentMission, verifyAgentMissionControl } from "./mission-agent-control"
import { controlAgentMissionSettings } from "./mission-agent-settings"
import { MissionPreferenceConflictError } from "../../settings/mission-preference-condition"
import { PluginControlsError } from "../../opencode/plugin-controls"
import type { SubagentDepthSettings } from "../../opencode/subagent-depth-settings"
import { z } from "zod"
import { readAgentMissionProject } from "./mission-agent-read"
import type { ForgeWorkItems } from "../../forge/work-items"
import type { NativeScheduleCapabilityReader } from "../../opencode/native-schedule-capability"
import type { ScheduledPreparationDeps } from "./mission-prepare-scheduled"
import { readMissionConfigurations, readMissionProfileDefaults } from "./mission-profile-defaults"
import { interruptMissionTask, observeMissionTask } from "./mission-task-native"
import { requestAdmission } from "../request-admission"
import { MissionCreationHoldError } from "./mission-creation-holds"
import { DeveloperInspectionTargets } from "../../automation/developer-inspection-targets"
import { isRestartSuccessor, readDeveloperRestart, readDeveloperTarget, sameDeveloperTarget, type DeveloperTarget } from "../../automation/developer-restart"
import { missionRecoveryControlError, missionRecoveryRejection } from "../../missions/recovery-error"
import { verifyMissionHumanAnswer } from "./mission-human-answer"
import { verifyRecurrenceRequest, type VerifyScheduleAgentCreation } from "./mission-recurrence-proof"
import type { SettingsService } from "../../settings/service"
import type { SessionPermissionModes } from "../../permissions/session-mode"
import type { RemoteControlManager } from "../../remote-control/manager"
import type { MemoryService } from "../../memory/service"
import { memoryErrorReply } from "./memory"
import { prepareSessionMemoryContext } from "../../workspaces/session-memory-context"

interface AutomationPluginRouteDeps {
  permissionModes?: SessionPermissionModes
  authManager: AuthManager
  bridgeToken: string
  nativeParent: NativeParent
  workspaceManager: WorkspaceManager
  developerCdp: DeveloperCdp
  worktreeDeletionFence?: WorktreeDeletionFence
  settings?: Pick<SettingsService, "getProfileScope"> & Partial<Pick<SettingsService, "getRawConfigOwner" | "mergePatchOwner" | "configYamlPathForAuthority">>
  subagentDepth?: Pick<SubagentDepthSettings, "read" | "update">
  scheduleSettingsActivation?: ScheduledPreparationDeps["scheduleSettingsActivation"]
  scheduleCapability?: Pick<NativeScheduleCapabilityReader, "read">
  remoteDevices?: Pick<RemoteControlManager, "isDeviceAuthorized">
  verifyScheduleAgentCreation?: VerifyScheduleAgentCreation
  memory?: MemoryService
  forge?: Pick<ForgeWorkItems, "openRepository">
}

interface DeveloperNativeStatus {
  status: {
    state: string
    runId?: string
    nativeIdentity?: string
    cdpUrl?: string
    windowId?: string
    windowInstance?: string
    restartId?: string
  }
  logs?: DeveloperCdpDiagnostic[]
  windows?: Array<{ windowId: string; windowInstance?: string; focused: boolean }>
}

function developerSelection(status: DeveloperNativeStatus["status"]): DeveloperCdpSelection | undefined {
  if (status?.state !== "ready" || typeof status.runId !== "string" || typeof status.nativeIdentity !== "string"
    || typeof status.cdpUrl !== "string" || typeof status.windowId !== "string") return undefined
  return { endpoint: status.cdpUrl, runId: status.runId, windowId: status.windowId,
    ...(status.windowInstance ? { windowInstance: status.windowInstance } : {}) }
}

function nativeWindowParams(window: { runId: string; windowId: string; windowInstance?: string }) {
  return { windowId: window.windowId, runId: window.runId,
    ...(window.windowInstance ? { windowInstance: window.windowInstance } : {}) }
}

function sameNativeWindow(window: DeveloperCdpSelection, status: DeveloperCdpSelection | undefined): boolean {
  return window.runId === status?.runId && window.windowId === status.windowId
    && window.windowInstance === status.windowInstance && window.endpoint === status.endpoint
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
    const body = request.body as { mode?: unknown; sessionID?: unknown; command?: unknown; purpose?: unknown
      deadline?: unknown; target?: unknown; pin?: unknown; order?: unknown } | undefined
    if (body?.mode === "human-answer-verify") {
      if (!deps.settings) return reply.code(503).send({ error: "Human answer admission unavailable" })
      try { return reply.send({ result: await verifyMissionHumanAnswer(body.command,
        { auth: deps.authManager, manager: deps.workspaceManager, settings: deps.settings, remoteDevices: deps.remoteDevices }, lifetime.signal) }) }
      catch { return reply.code(403).send({ error: "Human answer admission unavailable" }) }
    }
    if (body?.mode === "recurrence-control-verify") {
      try {
        return reply.send({ result: await verifyRecurrenceRequest(body.command, {
          auth: deps.authManager, manager: deps.workspaceManager, settings: deps.settings, remoteDevices: deps.remoteDevices,
          verifyAgentCreation: deps.verifyScheduleAgentCreation,
        }, lifetime.signal) })
      } catch { return reply.code(403).send({ error: "Recurrence human admission unavailable" }) }
    }
    if (!body || !["developer-probe", "developer-execute", "developer-restart", "developer-reconnect", "browser-claim", "mission-input", "memory-probe", "memory-input", "memory-context"].includes(String(body.mode))
      || typeof body.sessionID !== "string" || body.sessionID.length > 256) {
      return reply.code(400).send({ error: "Invalid automation bridge request" })
    }
    const sessionID = body.sessionID
    const rawDeveloper = body.mode === "developer-execute" ? body.command as { action?: unknown; ref?: unknown } : undefined
    const order = typeof body.order === "string" ? /^([a-f0-9-]{36})\/(\d{1,12})$/.exec(body.order) : null
    const inspectionOrder = order ? { source: order[1], sequence: Number(order[2]) } : undefined
    const selecting = rawDeveloper?.action === "inspect" && (rawDeveloper.ref === undefined || rawDeveloper.ref === "")
    const unavailableInspection = () => reply.code(404).send({
      code: "target-gone", error: "The inspection is unavailable; choose a window in inspect({targets:true})",
    })
    if (selecting && body.pin !== undefined && !inspectedTargets.get(sessionID, body.pin)) return unavailableInspection()
    const publishInspection = selecting ? inspectedTargets.begin(sessionID, inspectionOrder) : undefined
    if (selecting && !publishInspection) return reply.code(409).send({ code: "stale-inspection", error: "A newer inspection selected the window" })
    if (body.mode === "memory-probe" || body.mode === "memory-input" || body.mode === "memory-context") {
      if (!deps.memory) return reply.code(503).send({ code: "unreadable", error: "Memory is unavailable" })
      try {
        if (body.mode === "memory-probe") {
          await deps.memory.probe(body.sessionID)
          return reply.send({ result: { available: true } })
        }
        if (body.mode === "memory-context") {
          await deps.memory.probe(body.sessionID)
          const connection = await Promise.any(deps.workspaceManager.list().map(async workspace => {
            const connection = await deps.workspaceManager.getSharedServiceConnection(workspace.id)
            if (!connection) throw new Error("Memory connection is unavailable")
            return connection
          }))
          return reply.send({ result: await prepareSessionMemoryContext(connection, deps.memory, body.sessionID, lifetime.signal) })
        }
        return reply.send({ result: await deps.memory.executeAgent(body.sessionID, body.command) })
      } catch (error) { return memoryErrorReply(reply, error) }
    }
    // Lifecycle Pause/Stop and a retired task's interrupt walk and interrupt whole native
    // subagent families; they stay below the plugin's 95 s bridge timeout.
    const commandKind = body?.command && typeof body.command === "object" && "kind" in body.command ? body.command.kind : undefined
    const preferenceProbe = body.mode === "browser-claim" && (body.purpose === "mission-preferences" || body.purpose === "mission-prepare")
      || body.mode === "mission-input" && (commandKind === "profile-defaults" || commandKind === "configurations" || commandKind === "settings")
    const preferenceUnavailable = () => {
      const failure = missionRecoveryControlError("mission-preferences-unavailable")
      return reply.code(503).send({ error: failure.message, code: failure.code })
    }
    const notOwner = (error: string) => reply.code(404).send({ error, ...(preferenceProbe ? { code: "mission-not-owner" } : {}) })
    const readSignal = lifetime.signal
    const lifecycle = commandKind === "lifecycle" || commandKind === "interrupt" || commandKind === "schedule" || commandKind === "project-control"
    const signal = body.mode === "mission-input"
      ? AbortSignal.any([lifetime.signal, AbortSignal.timeout(lifecycle ? 85_000 : 30_000)]) : readSignal

    let reconnect: { native: DeveloperNativeStatus; target: DeveloperTarget; restartId: string } | undefined
    if (body.mode === "developer-reconnect") {
      const expected = readDeveloperRestart(body.command)
      if (!expected) return reply.code(400).send({ error: "Invalid developer reconnect target" })
      let native: DeveloperNativeStatus
      try { native = await deps.nativeParent.request<DeveloperNativeStatus>("developer.reconnect", expected, 2_000) }
      catch { return reply.code(404).send({ error: "No matching CodeNomad relaunch" }) }
      const target = readDeveloperTarget(native?.status)
      if (!target || !isRestartSuccessor(expected, target, native.status.restartId)) {
        return reply.code(404).send({ error: "No matching CodeNomad relaunch" })
      }
      const result = { developerTarget: target, restartId: expected.restartId }
      // An absent window may also mean no restored project owns the session.
      // The native receipt can prove the relaunch without disclosing renderer data.
      if (native.status.state === "missing") return reply.send({ ...result, windowState: "missing" })
      if (body.purpose === "confirm" || native.status.state !== "ready" || typeof native.status.cdpUrl !== "string"
        || expected.windowInstance && !target.windowInstance) {
        return reply.send({ ...result, windowState: "pending" })
      }
      reconnect = { native, target, restartId: expected.restartId }
    }
    const reconnectWaiting = ({ target, restartId }: NonNullable<typeof reconnect>, windowState: "pending" | "superseded" = "pending") => reply.send({
      developerTarget: target, restartId, windowState,
    })
    let location
    try {
      signal.throwIfAborted()
      const client = await lifetime.wait(deps.workspaceManager.getSharedServiceClient(), readSignal)
      signal.throwIfAborted()
      location = (await lifetime.wait(client.session.get({ sessionID: body.sessionID }, { signal }), readSignal)).location
    } catch (error) {
      if (reconnect) return reconnectWaiting(reconnect)
      if (preferenceProbe && (signal.aborted || !isSessionNotFoundError(error))) return preferenceUnavailable()
      return notOwner("Session not found")
    }
    let owned: boolean, ownershipReadFailed = false
    try {
      const workspaces = deps.workspaceManager.list()
      const reads = workspaces.map(async workspace => {
        try { if (await deps.workspaceManager.ownsLocation(workspace.id, location, undefined, { signal, strict: preferenceProbe })) return workspace.id }
        catch { ownershipReadFailed = true }
        throw new Error("Not an owner")
      })
      owned = await lifetime.wait(Promise.any(reads), readSignal).then(() => true, () => false)
    } catch (error) {
      if (preferenceProbe) return preferenceUnavailable()
      throw error
    }
    if (preferenceProbe && (signal.aborted || !owned && ownershipReadFailed)) return preferenceUnavailable()
    if (!owned) return reconnect ? reconnectWaiting(reconnect) : notOwner("Session is not owned by this CodeNomad instance")

    if (body.mode === "developer-restart") {
      const expected = readDeveloperRestart(body.command)
      if (!expected) return reply.code(400).send({ error: "Invalid developer restart target" })
      const identity = inspectedTargets.get(sessionID, body.pin)
      if (body.pin === undefined) {
        return reply.code(404).send({ code: "inspect-required", error: "Run codenomad.inspect before restarting this window" })
      }
      const current = () => {
        signal.throwIfAborted()
        if (!identity || identity.runId !== expected.runId || identity.windowId !== expected.windowId
          || identity.windowInstance !== expected.windowInstance || !inspectedTargets.isCurrent(sessionID, identity)) {
          throw new Error("The inspected CodeNomad window changed; inspect again")
        }
        return identity
      }
      try {
        const pinned = current()
        const native = await deps.nativeParent.request<DeveloperNativeStatus>("developer.status", nativeWindowParams(pinned))
        const target = readDeveloperTarget(native.status)
        if (!target || !sameDeveloperTarget(expected, target) || !sameNativeWindow(pinned, developerSelection(native.status))) {
          throw new Error("The inspected CodeNomad window changed; inspect again")
        }
        await deps.developerCdp.context(pinned, current)
        current()
        inspectedTargets.forgetRun(sessionID, expected.runId)
        // Older hosts accepted an unscoped restart; a distinct method keeps a mixed build inert.
        let retired = false
        const retireRun = () => {
          if (retired) return
          retired = true
          inspectedTargets.retireRun(expected.runId)
          // An ACK precedes native shutdown; the exact window can still close and cancel it.
          deps.developerCdp.close(expected.runId, true)
        }
        signal.addEventListener("abort", retireRun, { once: true })
        let result: unknown
        try {
          result = await deps.nativeParent.request("developer.restartScope", expected)
        } catch (error) {
          if (error instanceof NativeRequestRefused) throw error
          retireRun()
          return reply.code(502).send({ code: "restart-outcome-unknown", error: "Native restart outcome is unknown" })
        } finally {
          signal.removeEventListener("abort", retireRun)
        }
        retireRun()
        return reply.send({ result })
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) })
      }
    }

    if (reconnect) {
      const { native, target, restartId } = reconnect
      const canReconnect = () => inspectedTargets.canReconnect(sessionID, restartId)
      const publish = inspectedTargets.begin(sessionID, inspectionOrder, restartId)
      if (!publish) return reconnectWaiting(reconnect, "superseded")
      try {
        const identity = developerSelection(native.status)
        if (!identity) return reconnectWaiting(reconnect)
        const result = await deps.developerCdp.inspect(identity, undefined, { beforeRead: () => {
          signal.throwIfAborted()
          if (!canReconnect()) throw new Error("A newer inspection is selected")
        } })
        signal.throwIfAborted()
        if (result.context.windowId !== target.windowId || result.context.windowInstance !== target.windowInstance) {
          return reconnectWaiting(reconnect)
        }
        const after = await deps.nativeParent.request<DeveloperNativeStatus>("developer.status", nativeWindowParams(identity))
        if (!sameNativeWindow(identity, developerSelection(after.status))) return reconnectWaiting(reconnect)
        signal.throwIfAborted()
        const { document, ...inspection } = result
        const pin = publish({ ...identity, ...(document ? { document } : {}) })
        if (!pin) return reconnectWaiting(reconnect, canReconnect() ? "pending" : "superseded")
        result.diagnostics.push(...(native.logs ?? []).slice(-32))
        return reply.send({ result: { ...inspection, pin }, developerTarget: target, restartId, windowState: "inspected" })
      } catch {
        return reconnectWaiting(reconnect, canReconnect() ? "pending" : "superseded")
      }
    }

    if (body.mode === "mission-input") {
      try {
        if (commandKind === "profile-defaults") return reply.send({ result: readMissionProfileDefaults(deps.settings, body.command) })
        if (commandKind === "configurations") return reply.send({ result: readMissionConfigurations(deps.settings, body.command) })
        if (commandKind === "settings") return reply.send({ result: await controlAgentMissionSettings(deps, body.sessionID, body.command, signal) })
        if (!deps.worktreeDeletionFence) return reply.code(503).send({ error: "Mission dispatch unavailable" })
        // Journal-keyed creation capability of the owning backend. Durable
        // admission does not use this bridge or gain a new native API fallback.
        const fence = deps.worktreeDeletionFence
         const result = commandKind === "create-root"
          ? await createManagedMissionRoot(deps.workspaceManager, fence, body.sessionID, body.command, signal, deps.permissionModes)
          : commandKind === "prepare" ? await prepareCoordinatorMission(deps.workspaceManager, fence, body.sessionID, body.command, signal,
             { settings: deps.settings, bridgeToken: deps.bridgeToken, scheduleSettingsActivation: deps.scheduleSettingsActivation }, deps.permissionModes)
             : commandKind === "project-read" ? await readAgentMissionProject(deps, body.sessionID, body.command, signal)
             : commandKind === "project-control" ? await controlAgentMission(deps, body.sessionID, body.command, signal)
             : commandKind === "project-control-verify" || commandKind === "project-update"
               ? await verifyAgentMissionControl(deps, body.sessionID, body.command, signal)
            : commandKind === "schedule" ? await controlAgentMissionSchedule({
             workspaceManager: deps.workspaceManager, worktreeDeletionFence: fence, settings: deps.settings,
              bridgeToken: deps.bridgeToken, scheduleSettingsActivation: deps.scheduleSettingsActivation,
              scheduleCapability: deps.scheduleCapability, permissionModes: deps.permissionModes,
           }, body.sessionID, body.command, signal)
          : commandKind === "task-sessions" ? await observeMissionTask(deps.workspaceManager, body.sessionID, body.command, signal)
          : commandKind === "interrupt" ? await interruptMissionTask(deps.workspaceManager, fence, body.sessionID, body.command, signal)
           : await admitMissionInput(deps.workspaceManager, fence, body.sessionID, body.command, signal, undefined, deps.memory, deps.permissionModes)
        return reply.send({ result })
      } catch (error) {
        if (commandKind === "settings" && (error instanceof MissionPreferenceConflictError || error instanceof PluginControlsError || error instanceof z.ZodError)) {
          return reply.send({ result: { refused: true, code: error instanceof MissionPreferenceConflictError ? "settings-conflict"
            : error instanceof PluginControlsError ? `settings-${error.kind}` : "settings-invalid" } })
        }
        if (error instanceof MissionCreationHoldError) {
          return reply.code(error.code === "creation-capacity" ? 503 : 409).send({ error: error.message, code: error.code })
        }
        // Native errors can contain environment snapshots or provider credentials.
        const recovery = missionRecoveryRejection(error)
        if (recovery) return reply.code(recovery.status).send({ error: recovery.message, code: recovery.code })
        return reply.code(502).send({ error: "Mission admission failed" })
      }
    }

    if (body.mode === "browser-claim") {
      return reply.send({ result: { available: true, ...(preferenceProbe ? { missionCreationDefaults: true, missionPreparationStart: true } : {}) } })
    }

    let command
    let explicit: DeveloperTargetSelector | undefined
    const probe = body.mode === "developer-probe"
    const inventory = probe && body.purpose === "targets"
    try {
      if (!probe) command = parseDeveloperAction(body.command)
      if (body.target !== undefined) {
        if (!(probe && body.purpose === "target") && (command?.action !== "inspect" || command.ref)) {
          throw new Error("Select another window in a fresh inspection")
        }
        explicit = parseDeveloperTarget(body.target)
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
    const pin = probe ? undefined : inspectedTargets.get(body.sessionID, body.pin)
    if (!probe && body.pin !== undefined && !pin) {
      return unavailableInspection()
    }
    const exact = explicit ?? pin
    if (command && (command.action !== "inspect" || command.ref) && !pin) {
      return reply.code(404).send({ code: "inspect-required", error: "Run codenomad.inspect before acting on this window" })
    }
    if (command?.action === "restart") {
      return reply.code(409).send({ error: "Restart requires a fresh inspection and matching desktop automation version" })
    }
    if (command && command.action !== "inspect" && pin && !inspectedTargets.isCurrent(sessionID, pin)) {
      return reply.code(409).send({ error: "The inspected CodeNomad window changed; inspect again" })
    }
    const unavailable = (error?: string) => reply.code(404).send(exact
      ? { code: "target-gone", error: "The selected window is unavailable; choose a window in inspect({targets:true})" }
      : { code: "no-window", error: error ?? "No ready local CodeNomad window for this backend" })
    let native: DeveloperNativeStatus
    try {
      native = await deps.nativeParent.request<DeveloperNativeStatus>(inventory ? "developer.targets" : "developer.status",
        exact ? nativeWindowParams(exact) : {})
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error))
    }
    const selection = developerSelection(native.status)
    if (!selection || exact && (selection.windowId !== exact.windowId || selection.runId !== exact.runId
        || selection.windowInstance !== exact.windowInstance)
      || explicit && explicit.nativeIdentity !== native.status.nativeIdentity
      || !explicit && pin && pin.endpoint !== selection.endpoint) return unavailable()

    if (probe) {
      const selected = { available: true, nativeIdentity: native.status.nativeIdentity, runId: selection.runId }
      if (inventory) {
        const local = (native.windows ?? []).slice(0, 16)
        try {
          const contexts = await deps.developerCdp.probeContexts(selection,
            new Map(local.map(window => [window.windowId, window.windowInstance])), body.sessionID)
          const windows = local.map(window => {
            const context = contexts.get(window.windowId)
            const visible = !!context && context.sessionId === body.sessionID && !context.instanceId?.includes("~")
            return { windowId: window.windowId, focused: window.focused === true,
              ...(window.windowInstance ? { windowInstance: window.windowInstance } : {}),
              session: visible ? "visible" : context?.sessionOpen ? "open" : context ? "elsewhere" : "unknown",
              ...(visible && context.tabId ? { tabId: context.tabId } : {}) }
          })
          return reply.send({ result: { ...selected, windows } })
        } catch { return unavailable() }
      }
      if (!explicit) {
        const windows = new Map([[selection.windowId, selection.windowInstance]])
        try {
          const contexts = await deps.developerCdp.probeContexts(selection, windows)
          if (!contexts.has(selection.windowId)) return unavailable()
        } catch { return unavailable() }
      }
      return reply.send({ result: { ...selected, windowId: selection.windowId,
        ...(selection.windowInstance ? { windowInstance: selection.windowInstance } : {}) } })
    }

    if (!command) return reply.code(400).send({ error: "Missing developer command" })
    const identity: DeveloperCdpIdentity = command.action === "inspect" && !command.ref ? selection : pin ?? selection
    const stillAvailable = async () => {
      if (!identity.windowInstance) return true
      const after = await deps.nativeParent.request<DeveloperNativeStatus>("developer.status", nativeWindowParams(identity))
        .catch(() => undefined)
      return sameNativeWindow(identity, after && developerSelection(after.status))
    }
    try {
      if (command.action === "inspect") {
        const result = await deps.developerCdp.inspect(identity, { ref: command.ref, query: command.query,
          ...(explicit ? { recoverUncertainRun: true } : {}) })
        if (!await stillAvailable()) return unavailable()
        result.diagnostics.push(...(native.logs ?? []).slice(-32))
        const nextPin = publishInspection?.({ ...identity, ...(result.document ? { document: result.document } : {}) })
        if (publishInspection && !nextPin) return reply.code(409).send({ code: "stale-inspection", error: "A newer inspection selected the window" })
        const { document: _document, ...inspection } = result
        return reply.send({ result: { ...inspection, ...(nextPin ? { pin: nextPin } : {}) } })
      }
      const checkAdmission = () => {
        signal.throwIfAborted()
        if (!inspectedTargets.isCurrent(sessionID, identity)) {
          throw new Error("The inspected CodeNomad window changed; inspect again")
        }
      }
      checkAdmission()
      if (command.action === "screenshot") {
        const image = await deps.developerCdp.screenshot(identity, checkAdmission)
        if (!await stillAvailable()) return unavailable()
        return reply.send({ result: { image: { data: image.data, mime: image.mediaType } } })
      }
      const result = await deps.developerCdp.act(identity, command, checkAdmission)
      return reply.send({ result: { ok: true, ...result } })
    } catch (error) {
      if (error instanceof StaleDeveloperDocument) return reply.code(409).send({ code: "stale-document", error: error.message })
      if (exact && error instanceof Error && /^(No CodeNomad page matches|CodeNomad window or active session changed|The selected window is no longer available)/.test(error.message)) {
        return unavailable()
      }
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) })
    }
    } finally { lifetime.dispose() }
  })
}
