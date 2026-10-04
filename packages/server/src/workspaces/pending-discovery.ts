import type { OpenCodeEvent } from "@opencode/client"
import type { ServiceConnection } from "./opencode-service"
import { PENDING_RECONCILIATION_HEADER } from "../api-types"
export { PENDING_RECONCILIATION_HEADER }

type Compaction = { active: boolean; created: number; sequence?: number }
type State = {
  compactions: Map<string, Compaction>
  settlements: Map<string, number>
  loadedOnly?: boolean
  checkedAt: number
  checking?: Promise<void>
}
const states = new WeakMap<ServiceConnection, State>()
const stateFor = (connection: ServiceConnection) => {
  let state = states.get(connection)
  if (!state) {
    state = { compactions: new Map(), settlements: new Map(), checkedAt: Date.now() }
    states.set(connection, state)
  }
  return state
}
export const PENDING_DISCOVERY_DEFERRED = "Pending discovery deferred during compaction; retain existing queues"

// Called in the authenticated shared stream consumer, before ownership routing.
// This is admission state only: no native placement/request data is published.
export function observePendingDiscovery(connection: ServiceConnection, event: OpenCodeEvent): void {
  const starting = event.type === "session.compaction.started" || event.type === "session.compaction.delta"
  if (!starting && event.type !== "session.compaction.ended" && event.type !== "session.compaction.failed" && event.type !== "session.idle") return
  const state = stateFor(connection), id = event.data.sessionID
  const previous = state.compactions.get(id)
  if (event.type === "session.idle" && !previous?.active) return
  const sequence = "durable" in event ? event.durable.seq : undefined
  if (previous && (sequence === undefined ? event.created <= previous.created
    : previous.sequence !== undefined && sequence <= previous.sequence)) return
  state.compactions.set(id, { active: starting, created: Math.max(event.created, previous?.created ?? 0), sequence: sequence ?? previous?.sequence })
}

export function carryPendingCompactions(previous: ServiceConnection, next: ServiceConnection): void {
  const old = states.get(previous)
  if (!old) return
  const state = stateFor(next)
  for (const [id, entry] of old.compactions) if (entry.active) state.compactions.set(id, entry)
  state.checkedAt = 0
  // Capability and settlement grants are deliberately not carried across connections.
}

export function markLoadedPendingSupported(connection: ServiceConnection, supported: boolean): void {
  stateFor(connection).loadedOnly = supported
}

export function grantPendingReconciliation(connection: ServiceConnection, workspaceId: string, directory: string): void {
  const grants = stateFor(connection).settlements, now = Date.now()
  for (const [key, expiry] of grants) if (expiry <= now) grants.delete(key)
  // ponytail: bounded short-lived grants for attempted, authorized settlements.
  if (grants.size >= 64) grants.delete(grants.keys().next().value!)
  grants.set(JSON.stringify([workspaceId, directory]), now + 300_000)
}

export function deferPendingDiscovery(connection: ServiceConnection, options: {
  loadedOnly?: boolean; workspaceId?: string; reconciliationDirectory?: string
} = {}, now = Date.now()): boolean {
  connection.assertCurrent()
  const state = states.get(connection)
  if (!state || !Array.from(state.compactions.values()).some((entry) => entry.active)) return false
  // One read-only global status probe per connection/30s, never awaited by list
  // admission. Errors/timeouts retain the hold; a missing end clears only once
  // the session is inactive (the published API does not expose compaction phase).
  if (!state.checking && now - state.checkedAt >= 30_000) {
    state.checkedAt = now
    const baseline = new Map(state.compactions)
    const signal = AbortSignal.timeout(2000)
    state.checking = Promise.resolve().then(async () => {
      const active = await connection.client.session.active({ signal })
      signal.throwIfAborted()
      connection.assertCurrent()
      for (const [id, entry] of baseline) if (entry.active && state.compactions.get(id) === entry
        && !Object.prototype.hasOwnProperty.call(active, id)) state.compactions.set(id, { ...entry, active: false })
    }).catch(() => {}).finally(() => { state.checking = undefined })
  }
  if (options.loadedOnly && state.loadedOnly === true) return false
  if (options.workspaceId && options.reconciliationDirectory
    && (state.settlements.get(JSON.stringify([options.workspaceId, options.reconciliationDirectory])) ?? 0) > now) return false
  return true
}
