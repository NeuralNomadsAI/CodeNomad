import { MissionControl } from "../../missions/control"
import type { MissionDelegateInput, MissionInputTransport, MissionSessionAdapter } from "../../missions/control-types"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { matchesExecution } from "../../missions/execution"
import { MissionJournal, parseMissionEvent, type MissionStorage } from "../../missions/journal"
import type { MissionDocument } from "../../missions/mission-document"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import type { NativeHumanAnswerGate } from "../../missions/human-answer"
import type { MissionBusinessRoute } from "../missions-plugin"
import type { AutonomousProfileSource } from "./autonomous-environment"
import { readAutonomousMissionEnvironment } from "./autonomous-environment"
import { documentPassageBusinessAllowed, type ScheduledPassageAuthority } from "./native-scheduled-passage-authority"
import type { NativePassageObservation } from "./native-passage-observation"
import type { MissionNativeService } from "./native-service-adapter"

export type NativeScheduledPassageContext = {
  document: MissionDocument; locked: NativeMissionDocumentStore; storage: MissionStorage; native: MissionNativeService
  observation: Pick<NativePassageObservation, "assertCurrent" | "exists" | "session" | "children" | "requests">
  authority: ScheduledPassageAuthority; profile: AutonomousProfileSource; signal: AbortSignal; humanGate?: NativeHumanAnswerGate
  current(): true; now(): number; businessAllowed?(doc: MissionDocument): boolean
  environment?: typeof readAutonomousMissionEnvironment
  lifecycle?: MissionInputTransport["lifecycle"]
  qualifyBusiness?(): Promise<void>
}
const marker = (metadata: unknown): Record<string, unknown> => {
  if (!metadata || typeof metadata !== "object" || !("codenomad.mission" in metadata)) throw new Error("Document passage metadata unavailable")
  const value = metadata["codenomad.mission"]
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Document passage metadata unavailable")
  return value as Record<string, unknown>
}
export const scheduledPassageMarker = (doc: MissionDocument) => ({ missionID: doc.id, passageID: doc.pending!.id })

/** Reconstructed per invocation, including after restart/backend closure. It never
 * retains a borrowed Core service graph in a cross-invocation cache. */
export function nativeScheduledPassageBusiness(input: NativeScheduledPassageContext) {
  const { document: doc, native, observation, locked } = input, pending = doc.pending
  if (!pending) throw new Error("Document passage missing")
  const config = pending.configuration
  const current = (): true => { input.signal.throwIfAborted(); input.current(); return input.authority(doc, "observe") }
  const allowed = input.businessAllowed ?? documentPassageBusinessAllowed
  const effectCurrent = (): true => { current(); return input.authority(doc, "business") }
  const exact = async () => {
    const fresh = await locked.read(doc.id)
    if (!fresh || "deletedAt" in fresh || fresh.pending?.id !== pending.id || !allowed(fresh)) throw new Error("Document passage dispatch unavailable")
    return fresh
  }
  const passage = missionDocumentPassage(input.storage, doc, current, input.now)
  const scoped: MissionStorage = { ...passage.storage, set: async (key, value, supplied) => {
    current()
    const event = parseMissionEvent(value)
    if (event?.type === "task.created" || event?.type === "mission.revised" && event.addedTasks.length) {
      const fresh = await exact()
      await input.qualifyBusiness?.()
      if (!fresh.everCreatedTask) await locked.change(doc.id, fresh.revision, () => { input.current(); return locked.assertActive() }, next => { next.everCreatedTask = true })
      await passage.storage.set(key, value, () => { supplied?.(); return effectCurrent() })
      return
    }
    await passage.storage.set(key, value, supplied)
  } }
  const environment = async (sessionID: string) => {
    await exact(); current()
    const target = await native.get({ sessionID }, { signal: input.signal })
    if (target.projectID !== doc.projectID || target.location.directory !== native.location.directory
      || target.location.workspaceID !== native.location.workspaceID || !target.agent || !target.model) throw new Error("Document passage actor moved")
    if (!config.profileID || !config.executionHost) throw new Error("Document passage profile missing")
    const variables = await (input.environment ?? readAutonomousMissionEnvironment)({ profileID: config.profileID, executionHost: config.executionHost }, input.profile, input.signal)
    await native.environment({ sessionID, variables: { ...variables } }, { signal: input.signal }, effectCurrent,
      { id: target.id, parentID: target.parentID, projectID: target.projectID, location: target.location,
        metadata: target.metadata ?? {}, agent: target.agent, model: target.model })
    return target
  }
  const send = async (coordinatorID: string, kind: "prompt" | "synthetic", route: Parameters<MissionInputTransport["prompt"]>[1]) => {
    if (coordinatorID !== pending.coordinatorSessionID || marker(route.metadata).missionID !== pending.missionID) throw new Error("Document task input differs")
    await exact()
    const target = await native.get({ sessionID: route.sessionID }, { signal: input.signal })
    if (target.parentID || marker(target.metadata).missionID !== pending.missionID
      || canonicalAuthority(marker(target.metadata).document) !== canonicalAuthority(scheduledPassageMarker(doc))) throw new Error("Document task root differs")
    if (!(await observation.session(target.id, route.id)).messagePresent) {
      await environment(target.id)
      if (!(await observation.session(target.id, route.id)).messagePresent)
        await native.admit({ kind, input: route }, { signal: input.signal }, effectCurrent,
          { id: target.id, projectID: target.projectID, location: target.location, metadata: target.metadata ?? {}, agent: target.agent!, model: target.model! })
    }
    return { admitted: true, admissionID: route.id }
  }
  const create: MissionSessionAdapter["create"] = async request => {
    await exact()
    const selection = config.profiles?.roles?.[String(marker(request.metadata).role)]
    if (!selection || !request.agent || !request.model || !matchesExecution(selection, request)
      || request.location.directory !== native.location.directory || marker(request.metadata).missionID !== pending.missionID) throw new Error("Document task profile differs")
    await native.create({ id: request.id, title: request.title, location: request.location, agent: request.agent, model: request.model,
      metadata: { ...request.metadata, "codenomad.mission": { ...marker(request.metadata), document: scheduledPassageMarker(doc) } } },
    { signal: input.signal }, effectCurrent)
    return native.get({ sessionID: request.id }, { signal: input.signal })
  }
  const validateExecution = async (raw: MissionDelegateInput) => {
    const selection = config.profiles?.roles?.[raw.role]
    if (!selection || !matchesExecution(selection, raw.execution ?? selection)) throw new Error("Document task profile differs")
    if (!raw.targetSessionID) return
    const actor = await native.get({ sessionID: raw.targetSessionID }), state = await observation.session(actor.id)
    if (!matchesExecution(selection, actor) || state.active || state.inbox || state.runningTools || state.suspended
      || marker(actor.metadata).missionID !== pending.missionID) throw new Error("Document reused root unavailable")
    const ordinary = await new MissionJournal(input.storage, doc.projectID, doc.projectCanonical).snapshot()
    if (ordinary.discardedEvents || ordinary.controlUnavailable || ordinary.missions.some(mission => mission.status === "active"
      && mission.actors.some(candidate => candidate.sessionId === actor.id))) throw new Error("Document root belongs to another mission")
  }
  const control = new MissionControl({ project: { id: doc.projectID, canonical: doc.projectCanonical, location: native.location },
    storage: scoped, humanGate: input.humanGate, now: input.now, validateExecution,
    transport: { prompt: (id, route) => send(id, "prompt", route), synthetic: (id, route) => send(id, "synthetic", route),
      ...(input.lifecycle ? { lifecycle: (id, route) => {
        current()
        if (id !== pending.coordinatorSessionID || route.missionID !== pending.missionID) throw new Error("Document lifecycle identity differs")
        return input.lifecycle!(id, route)
      } } : {}) },
    sessions: { get: value => native.get(value), create, prompt: async () => { throw new Error("Use native subagents") },
      synthetic: async () => { throw new Error("Use document transport") } },
    isActive: () => { try { current(); return true } catch { return false } } })
  const route = (readSessionID: string): MissionBusinessRoute => ({ control, readSessionID, current,
    beforeTool: async (name, raw) => {
      current()
      const value = raw as { missionID?: unknown; start?: unknown; final?: unknown }
      if (value.start !== undefined || value.missionID !== undefined && value.missionID !== pending.missionID) throw new Error("Document business selector differs")
      if (name !== "inspect" && !(name === "report" && value.final !== true)) await exact()
    } })
  return { ...passage, control, route, environment }
}
