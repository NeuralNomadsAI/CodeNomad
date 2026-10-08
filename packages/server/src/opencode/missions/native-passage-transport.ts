import type { MissionInputTransport, MissionSessionAdapter } from "../../missions/control-types"
import type { PassageInput } from "./native-recurrence-admission"
import type { AutonomousMissionCommand } from "./autonomous-contract"
import { readAutonomousMissionEnvironment } from "./autonomous-environment"
import { matchesExecution } from "../../missions/execution"
import { MissionJournal } from "../../missions/journal"
import type { MissionDelegateInput } from "../../missions/control-types"
import { recurrenceDispatchAllowed } from "../../missions/recurrence-contract"

const marker = (metadata: Record<string, unknown> | undefined) => {
  const value = metadata?.["codenomad.mission"]
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Passage metadata unavailable")
  return value as Record<string, unknown>
}

/** Real MissionControl-generated assignment/report IDs, with native
 * first-admission-wins. No signing, effect reservations or replacement tools. */
export function nativePassageTransport(input: PassageInput, identity: { missionID: string; coordinatorSessionID: string }) {
  const { native, observation, document: doc } = input
  const current = input.current
  const effectCurrent = (): true => { current(); return observation.assertScheduleCurrent(doc, true) }
  const send = async (coordinatorID: string, kind: "prompt" | "synthetic", route: Parameters<MissionInputTransport["prompt"]>[1]) => {
    current()
    if (coordinatorID !== identity.coordinatorSessionID || marker(route.metadata).missionID !== identity.missionID)
      throw new Error("Passage transport identity differs")
    const fresh = await input.read()
    if (!fresh || fresh.pending?.passage.id !== doc.pending!.passage.id || !recurrenceDispatchAllowed(fresh)) throw new Error("Passage dispatch unavailable")
    const target = await native.get({ sessionID: route.sessionID })
    if (target.parentID || target.projectID !== doc.projectID || target.location.directory !== native.location.directory
      || target.location.workspaceID !== native.location.workspaceID || !target.agent || !target.model)
      throw new Error("Passage transport target moved")
    const exact = { id: target.id, projectID: target.projectID, location: target.location,
      metadata: target.metadata ?? {}, agent: target.agent, model: target.model }
    if (!(await observation.session(target.id, route.id)).messagePresent) {
      const variables = await readAutonomousMissionEnvironment(doc.config, input.profile, new AbortController().signal)
      await native.environment({ sessionID: target.id, variables: { ...variables } }, {}, effectCurrent, exact)
      if (!(await observation.session(target.id, route.id)).messagePresent)
        await native.admit({ kind, input: route } as AutonomousMissionCommand, {}, effectCurrent, exact)
    }
    current()
    return { admitted: true, admissionID: route.id }
  }
  const create: MissionSessionAdapter["create"] = async request => {
    current()
    const selection = doc.config.profiles?.roles?.[String(marker(request.metadata).role)]
    if (!request.id || !request.agent || !request.model || !selection || !matchesExecution(selection, request)
      || request.location?.directory !== native.location.directory
      || marker(request.metadata).missionID !== identity.missionID)
      throw new Error("Passage independent profile differs")
    const fresh = await input.read()
    if (!fresh || fresh.pending?.passage.id !== doc.pending!.passage.id || !recurrenceDispatchAllowed(fresh)) throw new Error("Passage dispatch unavailable")
    const metadata = { ...request.metadata, "codenomad.mission": { ...marker(request.metadata),
      recurrence: { scheduleID: doc.id, passageID: doc.pending!.passage.id } } }
    await native.create({ id: request.id, title: request.title ?? "Mission task", location: { directory: native.location.directory },
      metadata, agent: request.agent, model: request.model }, {}, effectCurrent)
    return native.get({ sessionID: request.id })
  }
  const validateExecution = async (raw: MissionDelegateInput) => {
    const selection = doc.config.profiles?.roles?.[raw.role]
    if (!selection || !matchesExecution(selection, raw.execution ?? selection)) throw new Error("Passage task profile differs")
    if (!raw.targetSessionID) return
    const actor = await native.get({ sessionID: raw.targetSessionID })
    const state = await observation.session(actor.id)
    if (!matchesExecution(selection, actor) || state.active || state.inbox || state.pending || state.runningTools || state.suspended
      || marker(actor.metadata).missionID !== identity.missionID) throw new Error("Passage reused root unavailable")
    const ordinary = await new MissionJournal(input.storage, doc.projectID, doc.projectCanonical).snapshot()
    if (ordinary.discardedEvents || ordinary.controlUnavailable || ordinary.missions.some(mission =>
      mission.status === "active" && mission.actors.some(candidate => candidate.sessionId === actor.id)))
      throw new Error("Passage root belongs to ordinary mission")
  }
  return { create, validateExecution, transport: { prompt: (id, route) => send(id, "prompt", route),
    synthetic: (id, route) => send(id, "synthetic", route) } satisfies MissionInputTransport }
}
