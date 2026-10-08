import { authorityDigest, canonicalAuthority, rejectAuthority } from "../../missions/authority-protocol"
import { parseRecurrenceDocument } from "../../missions/recurrence-contract"
import type { RecurrenceChildRecord, RecurrenceSettlement } from "../../missions/recurrence-authority-contract"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { controlOperationID } from "../../missions/receipt-identity"
import type { MissionStorage } from "../../missions/journal"
import { reportInput } from "../../missions/inputs"
import { recordNativeControlFailure } from "../../missions/native-control-failure"
import { recurrenceInput, recurrenceSources, recurrenceSourceLocationDigest } from "../../missions/recurrence-input"
import type { NativeRecurrenceAuthorityProvider } from "./native-authority-provider"

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const parse = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256 * 1024) rejectAuthority("observation-unavailable")
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed)) rejectAuthority("observation-unavailable")
  return parsed
}
const same = (left: unknown, right: unknown) => canonicalAuthority(left) === canonicalAuthority(right)
type Watermark = { sessionID: string; seq: number; ownerID: unknown; session: unknown }

/** Only normal, bounded native receipts. An unrecognised tool or a background
 * child leaves the original passage pending instead of guessing its lifetime. */
export async function observeNativeRecurrenceSettlement(provider: NativeRecurrenceAuthorityProvider,
  storage: MissionStorage, child: Readonly<RecurrenceChildRecord>, signal: AbortSignal) {
  return observeSettlement(provider, storage, child, signal, "completed")
}

/** Keep the succeeded observer unchanged for its callers. Only this finite-passage
 * branch can record an admitted execution's known terminal failure without native
 * tool/project/publication effects. Earlier provider attempts are not workflow replay. */
export async function observeNativeRecurrenceTerminalSettlement(provider: NativeRecurrenceAuthorityProvider,
  storage: MissionStorage, child: Readonly<RecurrenceChildRecord>, signal: AbortSignal) {
  signal.throwIfAborted()
  const failed = provider.readSession(child.grant.coordinatorSessionID).events
    .some(event => event.type === "session.execution.failed.1")
  return observeSettlement(provider, storage, child, signal, failed ? "failed" : "completed")
}

async function observeSettlement(provider: NativeRecurrenceAuthorityProvider,
  storage: MissionStorage, child: Readonly<RecurrenceChildRecord>, signal: AbortSignal, outcome: "completed" | "failed") {
  signal.throwIfAborted()
  const grant = child.grant, source = provider.readCurrent(provider.sourceKey)
  const document = parseRecurrenceDocument(source, provider.store.scope.projectID,
    provider.store.scope.projectCanonical, provider.store.scope.scheduleID)
  if (!document.pending || document.pending.passage.id !== grant.passage.id
    || document.pending.passage.messageID !== grant.messageID || document.pending.admission?.missionID !== grant.missionID
    || document.pending.admission.conversationID !== grant.coordinatorSessionID
    || !same(child.parent.body.config, document.config)
    || document.config.publication.policy !== "disabled") rejectAuthority("observation-unavailable")
  const effects = ["create", "start", "coordinator-message"]
  const sources = recurrenceSources(child), expectedInput = recurrenceInput(child)
  if (child.effects.length !== 3 + sources.length || effects.some(kind => !child.effects.some(item => item.effect.kind === kind
    && item.receipt?.outcome === "applied" && item.receipt.operationID === item.operationID && item.receipt.sourceMessages === undefined
    && item.receipt.evidenceID === (kind === "coordinator-message" ? grant.messageID : grant.coordinatorSessionID))))
    rejectAuthority("observation-unavailable")
  const messageEffect = child.effects.find(item => item.effect.kind === "coordinator-message")!.effect
  if (messageEffect.kind !== "coordinator-message" || messageEffect.messageID !== grant.messageID
    || messageEffect.contentDigest !== authorityDigest(expectedInput.text)) rejectAuthority("binding-mismatch")
  const sourcesCurrent = () => {
    const fresh = parseRecurrenceDocument(provider.readCurrent(provider.sourceKey), document.projectID, document.projectCanonical, document.id)
    if (!same(fresh.pending, document.pending) || !same(fresh.config, document.config) || !same(fresh.cursors, document.cursors))
      rejectAuthority("observation-unavailable")
    for (const source of sources) {
      const cursor = document.cursors.find(item => item.conversationID === source.conversationID)
      if ((cursor?.messageID ?? null) !== source.afterMessageID
        || cursor?.locationDigest !== undefined && cursor.locationDigest !== recurrenceSourceLocationDigest(source)) rejectAuthority("binding-mismatch")
      provider.assertSourcePlacement(source.conversationID, source)
    }
  }
  sourcesCurrent()

  const journal = recurrencePassage(outcome === "failed" ? provider.passageStorage(grant.passage.id) : storage,
    document, () => true).journal
  const snapshot = await journal.snapshot(), history = await journal.events()
  const mission = snapshot.missions[0]
  if (snapshot.missions.length !== 1 || snapshot.discardedEvents || snapshot.controlUnavailable
    || snapshot.notificationUnavailable || snapshot.cleanupUnavailable || history.discardedEvents
    || !mission || mission.id !== grant.missionID || mission.coordinatorSessionId !== grant.coordinatorSessionID
    || (outcome === "completed" ? mission.status !== "completed" : !["active", "failed"].includes(mission.status))
    || mission.control?.action !== "start" || mission.control.pending.length
    || !same(mission.control.recurrence, { grantID: grant.grantID, passageID: grant.passage.id,
      messageID: grant.messageID, coordinatorSessionID: grant.coordinatorSessionID })
    || mission.control.receipts?.length !== 1 || mission.control.receipts[0].acknowledgementState !== "known"
    || mission.control.receipts[0].nativeAcknowledgement?.disposition !== "start-admitted"
    || mission.control.receipts[0].nativeAcknowledgement.admission.id !== grant.messageID
    || mission.notificationUnavailable
    || mission.reports.some(report => report.notificationStatus === "pending")
    || !history.events.some(event => event.type === "mission.created" && event.missionID === grant.missionID
      && event.requestID === grant.passage.id)
    || outcome === "completed" && !history.events.some(event => event.type === "mission.finished" && event.missionID === grant.missionID
      && event.outcome === "completed")) rejectAuthority("observation-unavailable")
  let journalWatermark = provider.readJournalWatermark(grant.passage.id)
  if (outcome === "failed" && (mission.tasks.length || mission.reports.length || mission.actors.length !== 1
    || mission.control.id !== controlOperationID(grant.missionID, grant.passage.id))) rejectAuthority("observation-unavailable")
  const notifications = new Map(mission.reports.filter(report => report.notificationStatus === "admitted")
    .map(report => { const input = reportInput(mission, report); return [input.id, input] as const }))
  const queue = [{ sessionID: grant.coordinatorSessionID, parentID: undefined as string | undefined,
    prompt: undefined as string | undefined }], visited = new Set<string>(), watermarks: Watermark[] = []
  let terminal = "", failureSummary = ""
  while (queue.length) {
    signal.throwIfAborted()
    const { sessionID, parentID, prompt } = queue.shift()!
    if (visited.has(sessionID) || visited.size >= 32) rejectAuthority("observation-unavailable")
    visited.add(sessionID)
    const read = provider.readSession(sessionID, sessionID === grant.coordinatorSessionID ? grant.messageID : undefined)
    const session = read.session
    if (session.parent_id !== (parentID ?? null)
      || session.project_id !== provider.location.projectID || session.directory !== provider.location.directory
      || session.workspace_id !== (provider.location.workspaceID ?? null) || read.inbox !== 0 || read.pending !== 0
      || session.time_suspended !== null || read.ownerID !== null) rejectAuthority("observation-unavailable")
    if (sessionID === grant.coordinatorSessionID && !same(parse(session.metadata), {
      "codenomad.mission": { version: 1, missionID: grant.missionID, kind: "coordinator", role: "coordinator" },
    })) rejectAuthority("observation-unavailable")
    const events = read.events.map(row => {
      if (typeof row.id !== "string" || !Number.isSafeInteger(row.seq) || typeof row.type !== "string")
        rejectAuthority("observation-unavailable")
      return { id: row.id, seq: row.seq as number, type: row.type, data: parse(row.data) }
    })
    if (events.length !== read.seq + 1 || events.some((event, index) => event.seq !== index
      || event.data.sessionID !== sessionID || ["session.deleted.2", "session.moved.1", "session.forked.2",
        "session.revert.staged.1", "session.revert.committed.1"].includes(event.type)))
      rejectAuthority("observation-unavailable")
    const created = events.filter(event => event.type === "session.created.1")
    const starts = events.filter(event => event.type === "session.execution.started.1")
    const ended = events.filter(event => event.type === `session.execution.${outcome === "completed" ? "succeeded" : "failed"}.1`)
    if (created.length !== 1 || created[0].data.sessionID !== sessionID
      || created[0].data.parentID !== parentID
      || starts.length !== 1 || ended.length !== 1 || starts[0].seq >= ended[0].seq
      || events.some(event => (outcome === "completed" ? ["session.execution.failed.1", "session.execution.interrupted.1",
        "session.step.failed.1"] : ["session.execution.succeeded.1", "session.execution.interrupted.1"]).includes(event.type)))
      rejectAuthority("observation-unavailable")
    if (outcome === "failed") {
      // Deliberately limited to native no-route with no durable Step/tool evidence.
      // This does NOT prove zero provider HTTP requests: retry-full can precede a
      // durable Step. The admitted execution FAILED; its three startup effects
      // remain APPLIED. Native retries/billing are not workflow replay or tool grants.
      const error = ended[0].data.error
      if (sessionID !== grant.coordinatorSessionID || ended[0].seq !== read.seq
        || !object(error) || error.type !== "provider.no-route" || typeof error.message !== "string" || error.status !== undefined
        || events.some(event => !["session.created.1", "session.agent.selected.1", "session.model.selected.1",
          "session.instructions.updated.2", "session.inbox.enqueued.1", "session.inbox.delivered.1",
          "session.execution.started.1", "session.execution.failed.1"].includes(event.type))
        || read.messages.length !== 1 || read.messages[0].id !== grant.messageID || read.messages[0].type !== "synthetic")
        rejectAuthority("observation-unavailable")
      provider.assertNoSessionChildren(sessionID)
      failureSummary = error.message || error.type // Native diagnostic, never parsed into a result.
    }
    const enqueued = events.filter(event => event.type === "session.inbox.enqueued.1")
    const delivered = events.filter(event => event.type === "session.inbox.delivered.1")
    if (!enqueued.length || enqueued.length !== delivered.length
      || enqueued.some(event => !delivered.some(next => next.data.inboxID === event.data.inboxID
        && next.seq > event.seq && next.seq > starts[0].seq && next.seq < ended[0].seq))
      || enqueued.some(event => event.seq >= ended[0].seq)) rejectAuthority("observation-unavailable")
    if (sessionID === grant.coordinatorSessionID) {
      const original = enqueued.find(event => event.data.inboxID === grant.messageID)
      const message = read.message && parse(read.message.data)
      const expected = { version: 1, missionID: grant.missionID, kind: "lifecycle",
        operationID: controlOperationID(grant.missionID, grant.passage.id), taskMode: child.parent.body.config.taskMode,
        recurrence: { grantID: grant.grantID, passageID: grant.passage.id, messageID: grant.messageID,
          coordinatorSessionID: grant.coordinatorSessionID } }
      const missionMetadata = object(message?.metadata) ? message.metadata["codenomad.mission"] : undefined
      if (!original || enqueued.filter(event => event.data.inboxID === grant.messageID).length !== 1
        || read.message?.type !== "synthetic" || message?.text !== expectedInput.text
        || !object(missionMetadata) || Object.entries(expected).some(([key, value]) => !same(missionMetadata[key], value))
        || mission.control.receipts[0].nativeAcknowledgement?.disposition !== "start-admitted"
        || !same(mission.control.receipts[0].nativeAcknowledgement.admission.payload.metadata, message.metadata)
        || mission.control.receipts[0].nativeAcknowledgement.admission.payload.text !== message.text
        || !object(original.data.item) || original.data.item.type !== "synthetic"
        || !object(original.data.item.payload) || original.data.item.payload.text !== message.text
        || !same(original.data.item.payload.metadata, message.metadata)
        || enqueued.some(event => {
          if (event === original) return false
          const expected = notifications.get(String(event.data.inboxID))
          const item = event.data.item, delivered = read.messages.find(row => row.id === event.data.inboxID)
          const message = delivered && parse(delivered.data)
          return !expected || !object(item) || item.type !== "synthetic" || !object(item.payload)
            || item.payload.text !== expected.text || !same(item.payload.metadata, expected.metadata)
            || delivered?.type !== "synthetic" || message?.text !== expected.text
            || !same(message?.metadata, expected.metadata)
        }))
        rejectAuthority("observation-unavailable")
      terminal = ended[0].id as string
    } else {
      const first = enqueued[0], message = read.messages.find(row => row.id === first.data.inboxID && row.type === "user")
      const text = message && parse(message.data).text
      if (enqueued.length !== 1 || !object(first.data.item) || first.data.item.type !== "user"
        || !object(first.data.item.payload) || first.data.item.payload.text !== text
        || typeof prompt !== "string" || typeof text !== "string"
        || text !== `You are a subagent spawned by another session.\n${prompt}`) rejectAuthority("observation-unavailable")
    }

    const tools = new Map<string, { seq: number; messageID: string }>()
    const shells = new Set<string>()
    for (const event of events) {
      if (event.seq > ended[0].seq) {
        if (event.type.startsWith("session.execution.") || event.type.startsWith("session.inbox.")) rejectAuthority("observation-unavailable")
        continue // A later unrelated human Shell cannot be attributed to this passage.
      }
      if (event.type === "session.shell.started.1") {
        const shell = event.data.shell
        if (!object(shell) || typeof shell.id !== "string" || shells.has(shell.id)) rejectAuthority("observation-unavailable")
        shells.add(shell.id)
      }
      if (event.type === "session.shell.ended.1") {
        const shell = event.data.shell
        if (!object(shell) || shell.status === "running" || !shells.delete(String(shell.id))) rejectAuthority("observation-unavailable")
      }
      if (event.type === "session.tool.called.1") {
        const id = event.data.id, messageID = event.data.assistantMessageID
        if (typeof id !== "string" || typeof messageID !== "string" || event.data.executed !== true || tools.has(id))
          rejectAuthority("observation-unavailable")
        tools.set(id, { seq: event.seq as number, messageID })
      }
      if (event.type !== "session.tool.success.2" && event.type !== "session.tool.failed.2") continue
      const call = tools.get(String(event.data.id))
      const message = read.messages.find(row => row.id === call?.messageID && row.type === "assistant")
      const content = message && parse(message.data).content
      const parts = Array.isArray(content) ? content.filter(item => object(item) && item.type === "tool" && item.id === event.data.id) : []
      const part = parts[0]
      if (!call || call.seq >= event.seq || event.type !== "session.tool.success.2" || parts.length !== 1
        || !object(part) || !object(part.state) || part.state.status !== "completed"
        || event.data.executed !== true || part.executed !== true
        || !same(event.data.metadata ?? null, part.state.metadata ?? null)) rejectAuthority("observation-unavailable")
      if (part.name === "subagent") {
        const metadata = event.data.metadata
        if (!object(metadata) || metadata.status !== "completed" || typeof metadata.sessionID !== "string"
          || !object(part.state.input) || typeof part.state.input.prompt !== "string"
          || part.state.input.sessionID !== undefined || part.state.input.background === true
          || queue.some(item => item.sessionID === metadata.sessionID)
          || visited.has(metadata.sessionID)) rejectAuthority("observation-unavailable")
        queue.push({ sessionID: metadata.sessionID, parentID: sessionID, prompt: part.state.input.prompt })
      } else if (!["mission_inspect", "mission_delegate", "mission_report", "mission_revise", "mission_briefing", "shell"].includes(String(part.name))
        || part.name === "mission_inspect" && object(part.state.input) && part.state.input.start !== undefined
        || part.name === "shell" && (object(part.state.input) && part.state.input.background === true
          || !object(part.state.metadata) || part.state.metadata.status !== "completed")
        || part.name === "mission_delegate" && object(part.state.input) && part.state.input.executionMode !== undefined) {
        rejectAuthority("observation-unavailable")
      }
      tools.delete(String(event.data.id))
    }
    if (tools.size || shells.size || !ended[0].id) rejectAuthority("observation-unavailable")
    watermarks.push({ sessionID, seq: read.seq, ownerID: read.ownerID, session: read.session })
  }
  if (mission.actors.some(actor => !visited.has(actor.sessionId))) rejectAuthority("observation-unavailable")
  await provider.assertNoPendingRequests([...visited], outcome === "failed" ? "before-tools" : undefined)
  signal.throwIfAborted()
  const nativeCurrent = (): true => {
    signal.throwIfAborted()
    provider.assertCurrent()
    sourcesCurrent()
    provider.assertSessionWatermarks(watermarks)
    if (outcome === "failed") provider.assertNoSessionChildren(grant.coordinatorSessionID)
    return true
  }
  if (outcome === "failed") {
    nativeCurrent()
    provider.assertJournalWatermark(grant.passage.id, journalWatermark)
    await recordNativeControlFailure(journal, grant.missionID, { operationID: mission.control.id,
      sessionID: grant.coordinatorSessionID, messageID: grant.messageID, evidenceID: terminal,
      inputDigest: authorityDigest(expectedInput.text) }, failureSummary, nativeCurrent)
    journalWatermark = provider.readJournalWatermark(grant.passage.id)
  }
  const settlement: RecurrenceSettlement = { grantID: grant.grantID, evidenceID: terminal,
    outcome, effects: child.effects.map(item => item.receipt!), nativeIdle: true,
    controlsSettled: true, notificationsSettled: true, derivedCallsEnded: true }
  return { settlement, assertCurrent: (): true => {
    signal.throwIfAborted()
    provider.assertCurrent()
    sourcesCurrent()
    provider.assertJournalWatermark(grant.passage.id, journalWatermark)
    provider.assertSessionWatermarks(watermarks)
    if (outcome === "failed") provider.assertNoSessionChildren(grant.coordinatorSessionID)
    return true
  } }
}
