import { createHash } from "node:crypto"

// This boundary owns its output: no database object, key or free-text field escapes.
const digest = value => typeof value === "string" && Buffer.byteLength(value) <= 262144 ? createHash("sha256").update(value).digest("hex") : null
const opaque = value => { const hash = digest(value); return hash === null ? null : `sha256:${hash}` }
const integer = value => Number.isSafeInteger(value) ? value : null
const member = (value, choices) => choices.includes(value) ? value : null
const numbers = (row, keys) => Object.fromEntries(keys.map(key => [key, integer(row?.[key])]))
const identifiers = (row, keys) => Object.fromEntries(keys.map(key => [key, opaque(row?.[key])]))
const session = row => row && ({ ...identifiers(row, ["id", "parent_id"]),
  ...numbers(row, ["time_suspended", "time_busy", "time_idle"]), idleOutcomeSHA256: digest(row.idle_outcome) })
const proof = (row, scheduleID, messageID) => row && ({ ...identifiers(row, ["id"]),
  ...numbers(row, ["seq", "enqueued_seq", "time_created", "time_updated", "bytes", "textBytes"]),
  type: member(row.type, ["user", "synthetic", "assistant", "idle"]),
  typeSHA256: digest(row.type), deliverySHA256: digest(row.delivery),
  textSHA256: typeof row.textSHA256 === "string" && /^[a-f0-9]{64}$/.test(row.textSHA256) ? row.textSHA256 : null,
  bodyOmitted: row.bodyOmitted === true || row.error === "sql-message-overflow",
  ...(row.error === "sql-message-overflow" ? { error: "sql-message-overflow" } : {}),
  schedule: row.schedule && { id: opaque(row.schedule.id),
    correlated: typeof scheduleID === "string" && row.schedule.id === scheduleID && Number.isSafeInteger(row.schedule.run)
      && messageID === `msg_${scheduleID}_${row.schedule.run}`,
    ...numbers(row.schedule, ["run", "dueAt"]) } })

export function projectFailureSQL(state) {
  if (state.error) return { error: member(state.error, ["sql-path-refused", "sql-document-unavailable-or-overflow", "sql-slot-overflow",
    "sql-document-incompatible", "sql-passage-incompatible", "sql-unavailable-schema-lock-or-payload"]) ?? "sql-unavailable-schema-lock-or-payload" }
  const doc = state.document ?? {}, owner = doc.calendarOwner
  return {
    stringPolicy: "bounded-sha256-or-omitted",
    document: { ...identifiers(doc, ["id"]), ...numbers(doc, ["revision", "launchedCount", "settledCount", "successfulCount"]),
      state: member(doc.state, ["paused", "running", "stopped", "finished"]),
      scheduleActivation: { state: member(doc.scheduleActivation?.state, ["prepared", "partial", "ready", "failed"]) },
      calendarOwner: { auxiliaryReady: owner?.auxiliaryReady === true,
        slotCount: integer(owner?.slotCount ?? owner?.slots?.length), operation: { pending: !!owner?.operation?.pending } },
      pending: doc.pending && { ...identifiers(doc.pending, ["id", "coordinatorSessionID", "messageID"]),
        admissionAttempted: doc.pending.admissionAttempted === true, admittedAt: integer(doc.pending.admittedAt) } },
    schedules: (state.schedules ?? []).slice(0, 16).map(row => {
      const carrier = row.carrier ?? row
      const scheduleID = row.session_id === (carrier.sessionID ?? carrier.session?.id) ? row.id : undefined
      return { role: member(row.role, ["principal", "reconciliation"]), ...identifiers(row, ["id", "session_id", "last_message_id"]),
        status: member(row.status, ["active", "paused", "done"]), statusSHA256: digest(row.status),
        ...numbers(row, ["next_due_at", "run_count", "time_created", "time_updated", "retry_at", "when_bytes"]),
        whenSHA256: digest(row.native_when) ?? (typeof row.whenSHA256 === "string" && /^[a-f0-9]{64}$/.test(row.whenSHA256) ? row.whenSHA256 : null),
        last_outcome: null, lastOutcomeSHA256: digest(row.last_outcome), session: session(carrier.session),
        messages: (carrier.messages ?? []).slice(0, 64).map(item => ({ id: opaque(item.id ?? item.messageID),
          message: proof(item.message, scheduleID, item.id ?? item.messageID), inbox: proof(item.inbox, scheduleID, item.id ?? item.messageID) })) }
    }),
    business: state.business && { sessionID: opaque(state.business.sessionID), session: session(state.business.session),
      ...(state.business.error === "sql-session-overflow" ? { error: "sql-session-overflow" } : {}) },
    start: (state.start ?? []).slice(0, 64).map(row => proof(row)),
    startDetails: (state.startDetails ?? []).slice(0, 64).map(row => proof(row)),
    sessions: (state.sessions ?? []).slice(0, 16).map(session),
    claims: (state.claims ?? []).slice(0, 16).map(session), inboxCount: integer(state.inboxCount),
  }
}
