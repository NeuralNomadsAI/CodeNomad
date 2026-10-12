import type { WorkspaceEventPayload } from "../api-types"
import type { EventBus } from "../events/bus"
import { nativeEventConnections, type ServiceConnection } from "../workspaces/opencode-service"
import type { QuotaFailure } from "./quota-marks"
import type { ProviderAccountsService } from "./service"

type InstanceEvent = Extract<WorkspaceEventPayload, { type: "instance.event" }>
const MAX_SEEN = 1024
const MAX_PENDING = 8
const FAILURE_DEDUPE_MS = 10_000
const MAX_BODY_LENGTH = 65_536

export function quotaFailure(event: unknown): QuotaFailure | undefined {
  const value = event as { type?: unknown; created?: unknown; data?: { sessionID?: unknown; error?: unknown } } | undefined
  if (value?.type !== "session.step.failed" && value?.type !== "session.execution.failed") return
  const error = value.data?.error as { type?: unknown; response?: { body?: unknown } } | undefined
  const sessionID = value.data?.sessionID
  if (!error || error.type !== "provider.quota" || typeof sessionID !== "string" || !sessionID || sessionID.length > 512) return
  const failedAt = typeof value.created === "number" && Number.isFinite(value.created) && value.created >= 0 ? value.created : Date.now()
  return { sessionID, failedAt, ...limitName(error.response?.body) }
}

function limitName(body: unknown): { limitName?: string } {
  if (typeof body !== "string" || body.length > MAX_BODY_LENGTH) return {}
  try {
    const name = JSON.parse(body)?.metadata?.limitName
    return typeof name === "string" && name.length <= 64 ? { limitName: name } : {}
  } catch { return {} }
}

/**
 * Reactive safety net for adapters whose quota reads are unknown: observes
 * native quota failures already routed to owned workspaces. The listener stays
 * synchronous and bounded; attribution reads run off the relay, per connection,
 * and failures are dropped silently (native errors can contain credentials).
 */
export function observeProviderQuotaFailures(bus: EventBus, accounts: Pick<ProviderAccountsService,
  "observeSwitch" | "observeStepStart" | "markQuotaFailure" | "switchWatermark">) {
  const seen = new Set<string>()
  const recent = new Map<string, number>()
  const queues = new WeakMap<ServiceConnection, { tail: Promise<unknown>; pending: number }>()
  const once = (id: unknown) => {
    if (typeof id !== "string") return true
    if (seen.has(id)) return false
    if (seen.size >= MAX_SEEN) seen.delete(seen.values().next().value!)
    seen.add(id)
    return true
  }
  const handler = (payload: InstanceEvent) => {
    const event = payload.event as { id?: unknown; type?: unknown; created?: unknown; data?: any }
    if (event?.type !== "credential.switched" && event?.type !== "session.step.started"
      && event?.type !== "session.step.failed" && event?.type !== "session.execution.failed") return
    const connection = nativeEventConnections.get(payload.event)
    // Every owned workspace receives the same native event object.
    if (!connection || !once(event.id)) return
    const created = typeof event.created === "number" && Number.isFinite(event.created) ? event.created : Date.now()
    if (event.type === "credential.switched") {
      const credentialID = event.data?.credentialID
      if (typeof event.data?.integrationID === "string") accounts.observeSwitch(connection, event.data.integrationID, created,
        typeof credentialID === "string" || credentialID === null ? credentialID : undefined)
      return
    }
    if (event.type === "session.step.started") {
      if (typeof event.data?.sessionID === "string") {
        accounts.observeStepStart(connection, event.data.sessionID, created,
          typeof event.data.model?.providerID === "string" ? event.data.model.providerID : undefined)
      }
      return
    }
    const parsed = quotaFailure(event)
    if (!parsed) return
    // Switches observed after receipt (from other relay queues) fence the later attribution.
    const failure = { ...parsed, watermark: accounts.switchWatermark(connection) }
    // A failed step is usually followed by its failed execution.
    const previous = recent.get(failure.sessionID)
    if (previous !== undefined && Math.abs(failure.failedAt - previous) < FAILURE_DEDUPE_MS) return
    recent.delete(failure.sessionID)
    if (recent.size >= MAX_SEEN) recent.delete(recent.keys().next().value!)
    recent.set(failure.sessionID, failure.failedAt)
    let queue = queues.get(connection)
    if (!queue) { queue = { tail: Promise.resolve(), pending: 0 }; queues.set(connection, queue) }
    if (queue.pending >= MAX_PENDING) return
    const current = queue
    current.pending++
    current.tail = current.tail.catch(() => {})
      .then(() => accounts.markQuotaFailure(connection, failure, AbortSignal.timeout(10_000)))
      .catch(() => {})
      .finally(() => { current.pending-- })
  }
  bus.on("instance.event", handler)
  return () => { bus.off("instance.event", handler) }
}
