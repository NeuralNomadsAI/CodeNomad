import { authorityDigest, canonicalAuthority, rejectAuthority } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { parseRecurrenceDocument, type RecurrenceDocument } from "../../missions/recurrence-contract"
import { RecurrenceAuthority } from "../../missions/recurrence-authority-core"
import { authenticateRecurrenceStanding, recurrenceEffectID, type RecurrenceChildGrant, type RecurrenceEffect, type RecurrenceEffectReceipt } from "../../missions/recurrence-authority-contract"
import { recurrenceInput, recurrenceReadEvidence, recurrenceSourceCursors, recurrenceSources, recurrenceSourceLocationDigest } from "../../missions/recurrence-input"
import { assertRecurrenceDispatchFeasible, recurrenceInputBudget, recurrenceReadBudget, recurrenceSourceContextLimit } from "../../missions/recurrence-read-budget"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { MissionControl } from "../../missions/control"
import { matchesExecution } from "../../missions/execution"
import type { MissionInputTransport } from "../../missions/control-types"
import type { MissionStorage } from "../../missions/journal"
import type { NativeRecurrenceAuthorityProvider } from "./native-authority-provider"
import { nativeRecurrenceAdapter, type NativeRecurrenceInvocation, type NativeStandingSigner } from "./native-recurrence-adapter"
import type { MissionNativeService, NativeCreateInput, NativeRootPlacement } from "./native-service-adapter"
import type { AutonomousProfileSource } from "./autonomous-environment"
import { readAutonomousMissionEnvironment } from "./autonomous-environment"
import { controlOperationID } from "../../missions/receipt-identity"
import { DateTime } from "effect"
import type { NativeRecurrenceLifecycleCommand } from "./native-service-adapter"
import type { NativeRecurrenceOwner } from "./native-authority-provider"

type Owner = NativeRecurrenceOwner

type PassageInput = {
  document: Readonly<RecurrenceDocument>; provider: NativeRecurrenceAuthorityProvider
  signer: NativeStandingSigner; owner: Owner
  storage: MissionStorage; native: MissionNativeService; profile: AutonomousProfileSource
  signal: AbortSignal
  /** Daemon-service lifetime, never the due Job's cancellable dispatch signal. */
  settlementSignal: AbortSignal
  beforeEffect(): Promise<() => true>; now?: () => number
}

/** One due passage; durable operation reservations precede each native effect.
 * Neither lost ACKs nor process restarts enter this function a second time. */
export async function admitNativeRecurrencePassage(input: PassageInput) {
  const { provider, native, signal } = input, scope = provider.store.scope
  if (input.settlementSignal === signal) rejectAuthority("policy-unqualified")
  const doc = parseRecurrenceDocument(input.document, scope.projectID, scope.projectCanonical, scope.scheduleID)
  if (!doc.pending || doc.pending.admission || doc.state === "stopped"
    || doc.pending.passage.due.kind === "daily" && doc.state !== "running"
    || !recurrenceInputBudget(doc.config).sufficient
    || provider.location.directory !== native.location.directory
    || provider.location.projectID !== native.location.project.id
    || provider.location.projectCanonical !== native.location.project.canonical
    || !doc.config.roots.some(root => root.directory === native.location.directory)) rejectAuthority("binding-mismatch")
  let invocation: NativeRecurrenceInvocation | undefined
  const adapter = nativeRecurrenceAdapter({ ...input, invocation: () => invocation, settlementStorage: input.storage })
  const authority = new RecurrenceAuthority(provider.store, adapter)
  const dispatch = await input.beforeEffect()
  const current = (): true => {
    signal.throwIfAborted()
    native.assertCurrent()
    assertSynchronousAuthorityGuard(dispatch, "policy-unqualified")
    return provider.assertCurrent()
  }
  current()
  const hot = await provider.read()
  if (!hot || hot.parent.body.action !== "authorize" || hot.child
    || doc.config.publication.policy !== "disabled"
    || canonicalAuthority(hot.parent.body.config) !== canonicalAuthority(doc.config)
    || !("profileSource" in hot.parent.body)
    || canonicalAuthority(hot.parent.body.profileSource) !== canonicalAuthority(input.profile)) rejectAuthority("authorization-blocked")
  assertRecurrenceDispatchFeasible(doc.config, hot.parent.body.budgets)
  const grant = await provider.transact(current, () => authority.reservePassage(doc, hot.revision, signal))
  const passage = recurrencePassage(input.storage, doc, current, input.now)
  if (passage.missionID !== grant.missionID || passage.messageID !== grant.messageID) rejectAuthority("binding-mismatch")
  const effect = async (value: RecurrenceEffect) => {
    current()
    const fresh = await provider.read()
    if (!fresh?.child || fresh.child.grant.grantID !== grant.grantID) rejectAuthority("authorization-blocked")
    return provider.transact(current, () => authority.reserveEffect(grant.grantID, value, fresh.revision, signal))
  }
  const acknowledge = async (operationID: string) => {
    // Positive native return remains recordable after Pause. It cannot grant
    // another effect; the original signed child/operation stays exact.
    const fresh = await provider.read()
    if (!fresh?.child || fresh.child.grant.grantID !== grant.grantID) rejectAuthority("authorization-blocked")
    const evidenceSignal = AbortSignal.any([input.settlementSignal, AbortSignal.timeout(15_000)])
    return provider.transact(() => input.owner.assertCurrent(), () =>
      authority.acknowledgeEffect(grant.grantID, operationID, fresh.revision, evidenceSignal))
  }
  // One bounded ascending batch per explicitly followed exact source. The limit
  // is charged BEFORE Session.messages, including reads with an unknown ACK.
  const readMessages: NonNullable<RecurrenceEffectReceipt["sourceMessages"]>[] = []
  for (const conversationID of doc.config.watchedConversationIDs) {
    current()
    const target = await native.get({ sessionID: conversationID }, { signal })
    const cursor = doc.cursors.find(item => item.conversationID === conversationID)
    if (target.id !== conversationID || target.projectID !== scope.projectID
      || !doc.config.roots.some(root => root.directory === target.location.directory)
      || cursor?.locationDigest !== undefined && cursor.locationDigest !== recurrenceSourceLocationDigest(target.location)) rejectAuthority("binding-mismatch")
    const read = { directory: target.location.directory,
      ...(target.location.workspaceID === undefined ? {} : { workspaceID: target.location.workspaceID }),
      afterMessageID: cursor?.messageID ?? null,
      limit: recurrenceReadBudget(doc.config.watchedConversationIDs.length, hot.parent.body.budgets).readLimit,
      contextLimit: recurrenceSourceContextLimit(doc.config, readMessages) }
    provider.assertSourcePlacement(conversationID, read)
    const reserved = await effect({ kind: "inbox-read", conversationID, messageIDs: [], read })
    const readLedger = await provider.read()
    if (!readLedger?.child || readLedger.child.grant.grantID !== grant.grantID) rejectAuthority("authorization-blocked")
    const request = { sessionID: conversationID, ...read }
    invocation = { operationID: reserved.operation.operationID, input: { kind: "inbox-read", request } }
    try {
      const sourceMessages = await native.sourceMessages(request, { signal }, () => { current(); return reserved.assertCurrent() },
        () => {
          current()
          // Anchor access may yield; check the exact ORIGINAL invocation/child
          // again at messages entry, without issuing or consuming a second lease.
          adapter.assertEffectCurrent(provider.store, readLedger.child!, reserved.operation)
          return provider.assertSourcePlacement(conversationID, read)
        })
      invocation.acknowledgement = { operationID: reserved.operation.operationID, outcome: "applied",
        evidenceID: recurrenceReadEvidence(reserved.operation.effect, sourceMessages), sourceMessages }
      await acknowledge(reserved.operation.operationID)
      readMessages.push(sourceMessages)
    } finally { invocation = undefined }
  }
  // Source/output and prompt capacity is known before creating a coordinator.
  // Incomplete replies defer; overlarge replies carry exact unprocessed references.
  // Invalid/unknown evidence parks only the original read reservations.
  const readComplete = await provider.read()
  if (!readComplete?.child || readComplete.child.grant.grantID !== grant.grantID) rejectAuthority("authorization-blocked")
  recurrenceInput(readComplete.child)
  const coordinator = doc.config.profiles?.coordinator
  if (!coordinator?.agent || !coordinator.model) rejectAuthority("binding-mismatch")
  const request: NativeCreateInput = { id: grant.coordinatorSessionID,
    title: `Mission coordinator: ${doc.config.consigne}`.slice(0, 160),
    location: { directory: provider.location.directory },
    metadata: { "codenomad.mission": { version: 1, missionID: grant.missionID, kind: "coordinator", role: "coordinator" } },
    agent: coordinator.agent, model: coordinator.model }
  let exactRoot: NativeRootPlacement = { id: request.id, projectID: scope.projectID,
    location: { directory: request.location.directory, ...(native.location.workspaceID === undefined ? {} : { workspaceID: native.location.workspaceID }) },
    agent: request.agent, model: request.model, metadata: request.metadata }
  const previous = await passage.journal.snapshot()
  if (previous.missions.length || previous.discardedEvents || previous.controlUnavailable
    || previous.notificationUnavailable || previous.cleanupUnavailable) rejectAuthority("authorization-blocked")
  await passage.journal.assertCanAppend()
  const create = await effect({ kind: "create" })
  invocation = { operationID: create.operation.operationID, input: { kind: "create", request } }
  try {
    const session = await native.create(request, { signal }, () => { current(); return create.assertCurrent() })
    if (!session.agent || !session.model) rejectAuthority("effect-unavailable")
    exactRoot = Object.freeze({ ...exactRoot, agent: session.agent, model: Object.freeze({ ...session.model }) })
    // The typed native return is the only producer of this positive ACK.
    invocation.acknowledgement = { operationID: create.operation.operationID, outcome: "applied", evidenceID: session.id }
    await acknowledge(create.operation.operationID)
  } finally { invocation = undefined }

  let message: Awaited<ReturnType<typeof effect>> | undefined
  let command: NativeRecurrenceLifecycleCommand | undefined
  const { control, mission } = await reconcileNativeRecurrenceRoot(input, {
    prompt: async () => rejectAuthority("authorization-blocked"),
    synthetic: async () => rejectAuthority("authorization-blocked"),
    lifecycle: async (coordinatorID, route) => {
      if (coordinatorID !== grant.coordinatorSessionID || route.sessionID !== grant.coordinatorSessionID
        || route.missionID !== grant.missionID || route.operationID !== controlOperationID(grant.missionID, grant.passage.id)
        || canonicalAuthority(route.recurrence) !== canonicalAuthority({ grantID: grant.grantID,
          passageID: grant.passage.id, messageID: grant.messageID, coordinatorSessionID: grant.coordinatorSessionID })) {
        rejectAuthority("binding-mismatch")
      }
      current()
      const authorizedMessage = message, authorizedCommand = command
      if (!authorizedMessage || !authorizedCommand || !invocation
        || invocation.operationID !== authorizedMessage.operation.operationID) rejectAuthority("authorization-blocked")
      const receipt = await native.admit(authorizedCommand, { signal },
        () => { current(); return authorizedMessage.assertCurrent() }, exactRoot)
      if (receipt.type !== "synthetic" || receipt.delivery !== authorizedCommand.input.delivery
        || receipt.payload.text !== authorizedCommand.input.text
        || canonicalAuthority(receipt.payload.metadata) !== canonicalAuthority(authorizedCommand.input.metadata)) rejectAuthority("effect-unavailable")
      invocation.acknowledgement = { operationID: authorizedMessage.operation.operationID, outcome: "applied", evidenceID: receipt.id }
      const created = DateTime.toEpochMillis(receipt.time.created)
      if (!Number.isFinite(created) || created < 0) rejectAuthority("effect-unavailable")
      return { nativeAcknowledgement: { missionID: grant.missionID, operationID: route.operationID,
        sessionID: grant.coordinatorSessionID, action: "start", disposition: "start-admitted",
        admission: { ...receipt, time: { created } } } }
    },
  })
  current()
  if (mission.runState !== "prepared") rejectAuthority("authorization-blocked")
  const recurrence = { grantID: grant.grantID, passageID: grant.passage.id,
    messageID: grant.messageID, coordinatorSessionID: grant.coordinatorSessionID }
  // MissionControl owns the project business lock throughout lifecycle. Commit
  // authority reservations/receipts outside that lock, never from transport.
  const start = await effect({ kind: "start" })
  invocation = { operationID: start.operation.operationID,
    input: { kind: "start", sessionID: grant.coordinatorSessionID, variables: {} } }
  try {
    const variables = await readAutonomousMissionEnvironment(scope, input.profile, signal)
    invocation.input = { kind: "start", sessionID: grant.coordinatorSessionID, variables: { ...variables } }
    const target = await native.get({ sessionID: grant.coordinatorSessionID }, { signal })
    if (target.id !== grant.coordinatorSessionID || target.parentID || target.projectID !== scope.projectID
      || target.location.directory !== provider.location.directory || target.location.workspaceID !== native.location.workspaceID
      || !matchesExecution(request, target) || !matchesExecution(exactRoot, target)) rejectAuthority("binding-mismatch")
    await native.environment({ sessionID: grant.coordinatorSessionID, variables: { ...variables } }, { signal },
      () => { current(); return start.assertCurrent() }, exactRoot)
    invocation.acknowledgement = { operationID: start.operation.operationID, outcome: "applied",
      evidenceID: grant.coordinatorSessionID }
    await acknowledge(start.operation.operationID)
  } finally { invocation = undefined }
  const ready = await provider.read()
  if (!ready?.child || ready.child.grant.grantID !== grant.grantID) rejectAuthority("authorization-blocked")
  command = { kind: "synthetic", input: recurrenceInput(ready.child) }
  message = await effect({ kind: "coordinator-message", messageID: grant.messageID,
    contentDigest: authorityDigest(command.input.text) })
  invocation = { operationID: message.operation.operationID, input: { kind: "coordinator-message", command } }
  let running: Awaited<ReturnType<typeof control.lifecycle>>["mission"] | undefined, failure: unknown
  try {
    running = (await control.lifecycle({ missionID: grant.missionID, requestID: grant.passage.id,
      expectedRevision: mission.revision, action: "start", recurrence })).mission
  } catch (error) { failure = error }
  try {
    if (invocation?.acknowledgement) await acknowledge(message.operation.operationID)
  } finally { invocation = undefined }
  if (failure) throw failure
  if (!running) rejectAuthority("observation-unavailable")
  if (running.runState !== "running" || running.control?.pending.length) rejectAuthority("observation-unavailable")
  return { kind: "accepted" as const, passageID: grant.passage.id, messageID: grant.messageID,
    missionID: grant.missionID, conversationID: grant.coordinatorSessionID }
}

/** Reconcile the original pending passage, never redispatch. Archive the
 * immutable native result first; a crash before the separate calendar CAS
 * leaves the original pending identity available for archive-only recovery. */
export async function settleNativeRecurrencePassage(input: Omit<PassageInput, "beforeEffect">,
  calendar: NativeMissionRecurrenceStore) {
  const { provider, settlementSignal: signal } = input
  const source = await calendar.read(provider.store.scope.scheduleID)
  if (!source?.pending?.admission) rejectAuthority("observation-unavailable")
  const hot = await provider.read()
  const previous = await provider.store.readPassage(source.pending.passage.id)
  const grant = hot?.child?.grant ?? previous?.child.grant
  if (!grant || source.pending.passage.id !== grant.passage.id
    || source.pending.passage.messageID !== grant.messageID || source.pending.admission.missionID !== grant.missionID
    || source.pending.admission.conversationID !== grant.coordinatorSessionID
    || hot?.child && previous) rejectAuthority("observation-unavailable")
  const current = (): true => {
    signal.throwIfAborted()
    input.owner.assertCurrent(); input.native.assertCurrent()
    return provider.assertCurrent()
  }
  current()
  const authority = new RecurrenceAuthority(provider.store, nativeRecurrenceAdapter({ ...input,
    settlementStorage: input.storage }))
  const archive = previous ?? await provider.transact(current, () => authority.settle(grant.grantID, hot!.revision, signal))
  const outcome = archive.settlement.outcome
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "stopped" || archive.child.grant.grantID !== grant.grantID)
    rejectAuthority("observation-unavailable")
  const archived = (): true => {
    current()
    if (canonicalAuthority(provider.readCurrent(`${provider.store.parentKey}/passages/${grant.passage.id}`))
      !== canonicalAuthority(archive)) rejectAuthority("observation-unavailable")
    for (const source of recurrenceSources(archive.child)) provider.assertSourcePlacement(source.conversationID, source)
    return true
  }
  archived()
  return calendar.finish(source.id, { passageID: grant.passage.id, messageID: grant.messageID,
    missionID: grant.missionID, conversationID: grant.coordinatorSessionID, outcome,
    artifactMessageIDs: [], cursors: recurrenceSourceCursors(archive) }, Math.max(input.now?.() ?? Date.now(), grant.passage.createdAt), archived)
}

/** Recovery is metadata-only. A committed original create receipt and current
 * native session are necessary; there is NO second session.create call here. */
export async function reconcileNativeRecurrenceRoot(input: Omit<PassageInput, "beforeEffect">,
  transport?: MissionInputTransport) {
  const { provider, native } = input, scope = provider.store.scope
  const doc = parseRecurrenceDocument(input.document, scope.projectID, scope.projectCanonical, scope.scheduleID)
  const hot = await provider.read(), child = hot?.child, grant = child?.grant
  if (!doc.pending || !child || !grant || grant.passage.id !== doc.pending.passage.id
    || grant.messageID !== doc.pending.passage.messageID || hot?.scope.scheduleID !== doc.id
    || canonicalAuthority(child.parent.body.config) !== canonicalAuthority(doc.config)
    || !("profileSource" in child.parent.body)
    || canonicalAuthority(child.parent.body.profileSource) !== canonicalAuthority(input.profile)) rejectAuthority("binding-mismatch")
  const create = child.effects.find(item => item.operationID === recurrenceEffectID(grant, { kind: "create" }))
  if (!create || create.effect.kind !== "create" || create.receipt?.outcome !== "applied"
    || create.receipt.evidenceID !== grant.coordinatorSessionID) rejectAuthority("observation-unavailable")
  const signer = authenticateRecurrenceStanding(child.parent, await input.signer.readSigners()).signer
  const current = (): true => {
    input.settlementSignal.throwIfAborted()
    input.owner.assertCurrent(); native.assertCurrent(); provider.assertCurrent()
    input.signer.assertSignerCurrent(signer)
    const latest = provider.readCurrent(provider.store.key) as typeof hot
    if (!latest?.child || canonicalAuthority(latest.child.grant) !== canonicalAuthority(grant)
      || canonicalAuthority(latest.child.effects.find(effect => effect.operationID === create.operationID)) !== canonicalAuthority(create)) {
      rejectAuthority("observation-unavailable")
    }
    return true
  }
  current()
  const coordinator = child.parent.body.config.profiles?.coordinator
  if (!coordinator?.agent || !coordinator.model) rejectAuthority("binding-mismatch")
  const session = await native.get({ sessionID: grant.coordinatorSessionID }, { signal: input.settlementSignal })
  const metadata = { "codenomad.mission": { version: 1, missionID: grant.missionID, kind: "coordinator", role: "coordinator" } }
  const title = `Mission coordinator: ${doc.config.consigne}`.slice(0, 160)
  if (session.id !== grant.coordinatorSessionID || session.parentID || session.projectID !== scope.projectID
    || session.location.directory !== provider.location.directory || session.location.workspaceID !== native.location.workspaceID
    || session.title !== title || canonicalAuthority(session.metadata) !== canonicalAuthority(metadata)
    || !matchesExecution(coordinator, session)) {
    rejectAuthority("binding-mismatch")
  }
  current()
  const passage = recurrencePassage(input.storage, doc, current, input.now)
  if (passage.missionID !== grant.missionID || passage.messageID !== grant.messageID) rejectAuthority("binding-mismatch")
  const control = new MissionControl({ project: { id: scope.projectID, canonical: scope.projectCanonical,
    location: { directory: provider.location.directory } }, storage: passage.storage, now: input.now,
    sessions: { get: value => native.get(value, { signal: input.settlementSignal }),
      create: async () => rejectAuthority("authorization-blocked"),
      prompt: async () => rejectAuthority("authorization-blocked"),
      synthetic: async () => rejectAuthority("authorization-blocked") }, transport })
  const { mission } = await control.create({ requestID: grant.passage.id, objective: doc.config.consigne,
    notes: doc.config.notes,
    template: doc.config.template, profiles: doc.config.profiles, taskMode: doc.config.taskMode, prepared: true,
    coordinatorSessionID: grant.coordinatorSessionID, expectedCoordinatorLocation: session.location })
  if (mission.id !== grant.missionID || mission.coordinatorSessionId !== grant.coordinatorSessionID
    || mission.template !== doc.config.template
    || mission.notes !== doc.config.notes
    || canonicalAuthority(mission.profiles) !== canonicalAuthority(doc.config.profiles)
    || mission.taskMode !== doc.config.taskMode) rejectAuthority("binding-mismatch")
  return { control, mission }
}
