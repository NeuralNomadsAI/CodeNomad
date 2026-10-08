import { canonicalAuthority } from "../../missions/authority-protocol"
import { recurrenceDispatchAllowed, type RecurrenceDocument } from "../../missions/recurrence-contract"
import { passageStartInput, recurrenceSourceLocationDigest, type PassageSource } from "../../missions/recurrence-input"
import { recurrenceInputBudget, recurrenceSourceContextLimit } from "../../missions/recurrence-read-budget"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { MissionControl } from "../../missions/control"
import type { MissionStorage } from "../../missions/journal"
import type { NativeHumanAnswerGate } from "../../missions/human-answer"
import { matchesExecution } from "../../missions/execution"
import type { MissionNativeService, NativeCreateInput, NativeRootPlacement } from "./native-service-adapter"
import type { NativePassageObservation } from "./native-passage-observation"
import { readAutonomousMissionEnvironment, type AutonomousProfileSource } from "./autonomous-environment"
import { publishNativePassageBusiness } from "./native-passage-business"
import { nativePassageTransport } from "./native-passage-transport"

export type PassageInput = {
  document: RecurrenceDocument; storage: MissionStorage; native: MissionNativeService
  observation: NativePassageObservation; profile: AutonomousProfileSource; signal: AbortSignal
  current(): true; read(): Promise<RecurrenceDocument | undefined>; humanGate?: NativeHumanAnswerGate
  now?: () => number
  reconcileOnly?: boolean
}

/** Reserve in the calendar BEFORE entering here. Recovery checks both native
 * session and original inbox/message identity. No new IDs and no turn replay. */
export async function admitNativeRecurrencePassage(input: PassageInput) {
  const { document: doc, native, observation, signal } = input
  if (!doc.pending || !recurrenceInputBudget(doc.config).sufficient) throw new Error("Passage pending input unavailable")
  const current = (): true => { signal.throwIfAborted(); input.current(); return native.assertCurrent() }
  const effectCurrent = (): true => { current(); return observation.assertScheduleCurrent(doc, true) }
  current()
  if (native.location.project.id !== doc.projectID || native.location.project.canonical !== doc.projectCanonical
    || !doc.config.roots.some(root => root.directory === native.location.directory)) throw new Error("Passage Location differs")
  const passage = recurrencePassage(input.storage, doc, input.current, input.now)
  const coordinator = doc.config.profiles?.coordinator
  if (!coordinator?.agent || !coordinator.model) throw new Error("Passage profile unavailable")
  const metadata = { "codenomad.mission": { version: 1, missionID: passage.missionID, kind: "coordinator", role: "coordinator",
    recurrence: { scheduleID: doc.id, passageID: passage.passageID } } }
  const request: NativeCreateInput = { id: passage.coordinatorSessionID, title: `Mission coordinator: ${doc.config.consigne}`.slice(0, 160),
    location: { directory: native.location.directory }, metadata, agent: coordinator.agent, model: coordinator.model }
  const dispatch = async () => {
    const fresh = await input.read()
    if (!fresh || !recurrenceDispatchAllowed(fresh) || fresh.pending?.passage.id !== passage.passageID
      || canonicalAuthority(fresh.config) !== canonicalAuthority(doc.config)) throw new Error("Passage dispatch is not running")
    current()
  }
  const exists = await observation.exists(request.id)
  if (input.reconcileOnly && (!exists || !(await observation.session(request.id, passage.messageID)).messagePresent))
    throw new Error("Passage original admission unavailable; reconciliation cannot resend")
  if (!exists) await dispatch()
  const session = exists ? await native.get({ sessionID: request.id }, { signal }) : await native.create(request, { signal }, effectCurrent)
  if (session.id !== request.id || session.parentID || session.projectID !== doc.projectID
    || session.location.directory !== native.location.directory || session.location.workspaceID !== native.location.workspaceID
    || !matchesExecution(coordinator, session) || canonicalAuthority(session.metadata) !== canonicalAuthority(metadata))
    throw new Error("Passage coordinator differs")
  const exact: NativeRootPlacement = { ...request, projectID: doc.projectID, location: session.location }
  const productive = nativePassageTransport(input, passage)
  const control = new MissionControl({ project: { id: doc.projectID, canonical: doc.projectCanonical, location: session.location },
    storage: passage.storage, humanGate: input.humanGate, now: input.now,
    transport: productive.transport, validateExecution: productive.validateExecution,
    sessions: { get: value => native.get(value), create: productive.create,
      prompt: async () => { throw new Error("Use native subagent for passage tasks") },
      synthetic: async () => { throw new Error("Passage synthetic transport unavailable") } },
    isActive: () => { try { input.current(); return true } catch { return false } } })
  const { mission } = await control.create({ requestID: passage.passageID, objective: doc.config.consigne,
    notes: doc.config.notes, template: doc.config.template, profiles: doc.config.profiles, taskMode: doc.config.taskMode,
    coordinatorSessionID: request.id, expectedCoordinatorLocation: session.location })
  if (mission.id !== passage.missionID) throw new Error("Passage mission differs")
  publishNativePassageBusiness({ document: doc, coordinatorSessionID: request.id, missionID: passage.missionID,
    location: native.location, control, current: input.current, read: input.read,
    prepare: async sessionID => {
      input.current()
      const fresh = await input.read()
      if (!fresh || fresh.pending?.passage.id !== passage.passageID || !recurrenceDispatchAllowed(fresh)) throw new Error("Passage prompt unavailable")
      const target = await native.get({ sessionID })
      if (target.projectID !== doc.projectID || target.location.directory !== native.location.directory
        || target.location.workspaceID !== native.location.workspaceID) throw new Error("Passage prompt moved")
      const variables = await readAutonomousMissionEnvironment(doc.config, input.profile, new AbortController().signal)
      if (!target.agent || !target.model) throw new Error("Passage prompt execution unavailable")
      await native.environment({ sessionID, variables: { ...variables } }, {},
        () => { input.current(); return observation.assertScheduleCurrent(doc, true) },
        { id: target.id, parentID: target.parentID, projectID: target.projectID, location: target.location,
          metadata: target.metadata ?? {}, agent: target.agent, model: target.model })
    } })

  const observed = await observation.session(request.id, passage.messageID)
  if (!observed.messagePresent) {
    await dispatch()
    // Persist the exact bounded source snapshot before admitting the native
    // message. A crash cannot reread newer source prose under the same identity.
    const key = passage.inputKey
    let frozen = await input.storage.get(key) as unknown as { sources: PassageSource[]; input: ReturnType<typeof passageStartInput> } | undefined
    if (!frozen) {
      const sources: PassageSource[] = []
      for (const conversationID of doc.config.watchedConversationIDs) {
        current()
        const source = await native.get({ sessionID: conversationID }, { signal })
        const cursor = doc.cursors.find(item => item.conversationID === conversationID)
        if (source.projectID !== doc.projectID || !doc.config.roots.some(root => root.directory === source.location.directory)
          || cursor?.locationDigest !== undefined && cursor.locationDigest !== recurrenceSourceLocationDigest(source.location))
          throw new Error("Watched source moved")
        const messages = await native.sourceMessages({ sessionID: conversationID, ...source.location,
          afterMessageID: cursor?.messageID ?? null, limit: 32,
          contextLimit: recurrenceSourceContextLimit(doc.config, sources.map(source => source.messages)) }, { signal }, current, current)
        sources.push({ conversationID, ...source.location, afterMessageID: cursor?.messageID ?? null, messages })
      }
      frozen = { sources, input: passageStartInput(doc, passage, sources) }
      await input.storage.set(key, JSON.parse(JSON.stringify(frozen)), current)
    }
    if (canonicalAuthority(frozen.input) !== canonicalAuthority(passageStartInput(doc, passage, frozen.sources)))
      throw new Error("Passage frozen input differs")
    const variables = await readAutonomousMissionEnvironment(doc.config, input.profile, signal)
    await dispatch()
    await native.environment({ sessionID: request.id, variables: { ...variables } }, { signal }, effectCurrent, exact)
    // Recheck after preparation. Native first-admission-wins also fences the
    // original ID if another worker crossed this check concurrently.
    if (!(await observation.session(request.id, passage.messageID)).messagePresent) {
      await dispatch()
      await native.admit({ kind: "synthetic", input: frozen.input }, { signal }, effectCurrent, exact)
    }
  }
  current()
  return { kind: "accepted" as const, passageID: passage.passageID, messageID: passage.messageID,
    missionID: passage.missionID, conversationID: request.id }
}
