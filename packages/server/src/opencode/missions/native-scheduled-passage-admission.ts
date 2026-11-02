import { canonicalAuthority } from "../../missions/authority-protocol"
import { documentPassageStartInput } from "../../missions/mission-document-passage-input"
import { matchesExecution } from "../../missions/execution"
import { missionCoordinatorTitle } from "../../missions/mission-title"
import type { MissionDocument } from "../../missions/mission-document"
import type { DocumentPassageAdmission } from "../../missions/mission-document-passage-engine"
import { nativeScheduledPassageBusiness, scheduledPassageMarker, type NativeScheduledPassageContext } from "./native-scheduled-passage-business"
import { readAutonomousMissionEnvironment } from "./autonomous-environment"
import { documentPassageDispatchAllowed } from "./native-scheduled-passage-authority"

const same = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)

export async function readOriginalDocumentAdmission(input: NativeScheduledPassageContext, expected: ReturnType<typeof documentPassageStartInput>) {
  const pending = input.document.pending!, native = input.native
  if (!await input.observation.exists(pending.coordinatorSessionID)) return { present: false, exists: false }
  const queued = (await native.inbox(pending.coordinatorSessionID, { signal: input.signal })).find(item => item.id === pending.messageID)
  const message = await native.message({ sessionID: pending.coordinatorSessionID, messageID: pending.messageID }, { signal: input.signal })
  if (queued && (queued.type !== "synthetic" || queued.sessionID !== expected.sessionID || queued.delivery !== expected.delivery
    || !same(queued.payload, { text: expected.text, description: expected.description, metadata: expected.metadata }))) throw new Error("Original document inbox payload differs")
  if (message && (message.type !== "synthetic" || message.id !== expected.id || message.text !== expected.text
    || !same(message.metadata, expected.metadata))) throw new Error("Original document message payload differs")
  input.current()
  return { present: !!queued || !!message, exists: true }
}

/** Only the reserved original root/message can be admitted. A saved attempt needs
 * positive original proof; pruning preserves uncertainty instead of authorizing
 * another send. Recorded admission stays observe-only. */
export async function admitNativeScheduledPassage(input: NativeScheduledPassageContext,
  dispatchAllowed: (doc: MissionDocument) => boolean = documentPassageDispatchAllowed): Promise<DocumentPassageAdmission> {
  const doc = input.document, pending = doc.pending
  if (!pending) throw new Error("Document pending identity unavailable")
  const { native, observation, signal } = input
  const current = (): true => { signal.throwIfAborted(); input.current(); return input.authority(doc, "observe") }
  const publicationCurrent = (): true => { signal.throwIfAborted(); input.current(); return input.locked.assertActive() }
  const effectCurrent = (): true => { current(); return input.authority(doc, "initial") }
  const config = pending.configuration, selected = config.profiles?.coordinator
  if (!selected?.agent || !selected.model || !config.profileID || !config.executionHost) throw new Error("Frozen document profile unavailable")
  let original: ReturnType<typeof documentPassageStartInput>
  try { original = documentPassageStartInput(doc) } catch {
    // A deterministic capacity/source-proof refusal is not an absence proof.
    if (pending.admittedAt !== null || pending.admissionAttempted) return { kind: "unknown" }
    const exists = await observation.exists(pending.coordinatorSessionID)
    if (exists) {
      const state = await observation.session(pending.coordinatorSessionID, pending.messageID)
      if (state.messagePresent || state.active || state.inbox || state.suspended || state.runningTools
        || (await observation.children(pending.coordinatorSessionID)).length
        || await observation.requests([pending.coordinatorSessionID])) return { kind: "unknown" }
    }
    current()
    return { kind: "not-started", current: publicationCurrent }
  }
  const metadata = { "codenomad.mission": { version: 1, missionID: pending.missionID, kind: "coordinator", role: "coordinator",
    document: scheduledPassageMarker(doc) } }
  const observed = pending.admittedAt === null ? await readOriginalDocumentAdmission(input, original) : undefined
  if (pending.admittedAt === null && pending.admissionAttempted && !observed?.present) return { kind: "unknown" }
  const exists = observed?.exists ?? await observation.exists(pending.coordinatorSessionID)
  if (!exists && pending.admittedAt !== null) return { kind: "unknown" }
  if (!exists && !dispatchAllowed(doc)) return { kind: "not-started", current: publicationCurrent }
  const session = exists ? await native.get({ sessionID: pending.coordinatorSessionID }, { signal })
    : await native.create({ id: pending.coordinatorSessionID, title: missionCoordinatorTitle(config.title, config.objective),
      location: { directory: native.location.directory }, metadata, agent: selected.agent, model: selected.model }, { signal }, effectCurrent)
  if (session.parentID || session.id !== pending.coordinatorSessionID || session.projectID !== doc.projectID
    || session.location.directory !== native.location.directory || session.location.workspaceID !== native.location.workspaceID
    || !matchesExecution(selected, session) || !same(session.metadata, metadata)) throw new Error("Original document coordinator differs")
  const business = nativeScheduledPassageBusiness(input)
  await business.control.create({ requestID: pending.id, objective: config.objective, notes: config.notes, template: config.template,
    profiles: config.profiles, taskMode: config.taskMode, coordinatorSessionID: session.id, expectedCoordinatorLocation: session.location })
  const stored = await input.storage.get(business.inputKey)
  if (stored === undefined) await input.storage.set(business.inputKey, JSON.parse(canonicalAuthority({ input: original }, 128 * 1024)), current)
  else if (!same(stored, { input: original })) throw new Error("Original document frozen input differs")
  if (pending.admittedAt !== null) return { kind: "recorded", passageID: pending.id, messageID: pending.messageID,
    coordinatorSessionID: pending.coordinatorSessionID, at: pending.admittedAt }
  if (observed?.present) return { kind: "admitted", passageID: pending.id, messageID: pending.messageID,
    coordinatorSessionID: pending.coordinatorSessionID, at: input.now() }
  const state = await observation.session(session.id, pending.messageID)
  if (state.messagePresent) return { kind: "unknown" } // Only exact payload readback qualifies.
  if (!dispatchAllowed(doc)) {
    if (state.active || state.inbox || state.suspended || state.runningTools || (await observation.children(session.id)).length
      || await observation.requests([session.id])) return { kind: "unknown" }
    return { kind: "not-started", current: publicationCurrent }
  }
  const variables = await (input.environment ?? readAutonomousMissionEnvironment)({ profileID: config.profileID, executionHost: config.executionHost }, input.profile, signal)
  const exact = { id: session.id, projectID: doc.projectID, location: session.location, metadata, agent: selected.agent, model: selected.model }
  await native.environment({ sessionID: session.id, variables: { ...variables } }, { signal }, effectCurrent, exact)
  const beforeSend = await readOriginalDocumentAdmission(input, original)
  if (!beforeSend.present) {
    const fresh = await input.locked.read(doc.id)
    if (!fresh || "deletedAt" in fresh || fresh.pending?.id !== pending.id || fresh.pending.admissionAttempted
      || fresh.pending.admittedAt !== null) return { kind: "unknown" }
    // Write ahead of the native effect. A lost write ACK or later pruning keeps
    // the original uncertain; native absence can never authorize a second try.
    await input.locked.change(fresh.id, fresh.revision, publicationCurrent, next => { next.pending!.admissionAttempted = true })
    const acknowledgement = await native.admit({ kind: "synthetic", input: original }, { signal }, effectCurrent, exact)
    if (acknowledgement.type !== "synthetic" || acknowledgement.id !== original.id || acknowledgement.sessionID !== original.sessionID
      || acknowledgement.delivery !== original.delivery
      || !same(acknowledgement.payload, { text: original.text, description: original.description, metadata: original.metadata }))
      throw new Error("Original document admission acknowledgement differs")
  }
  current()
  return { kind: "admitted", passageID: pending.id, messageID: pending.messageID, coordinatorSessionID: pending.coordinatorSessionID, at: input.now() }
}
