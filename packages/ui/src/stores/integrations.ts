import { createSignal } from "solid-js"
import { fetchIntegrationBinding, fetchIntegrations } from "../lib/integrations-api"
import { createIntegrationBindingsStore } from "./integration-bindings-store"
import { createEventRefreshScheduler } from "../lib/event-refresh-scheduler"
import { backendEvents as serverEvents } from "../lib/server-events"
import { parseInstanceKey } from "../lib/backend-identity"
import { createIntegrationsStore, isIntegrationRefreshEvent } from "./integrations-store"

export const integrations = createIntegrationsStore(fetchIntegrations, { signal: id => serverEvents.signalForInstance(id) })
export const integrationBindings = createIntegrationBindingsStore(fetchIntegrationBinding, { signal: target => serverEvents.signalForInstance(target.instanceId) })
// Invalidates live offer snapshots, including across reconnects. Action receipts have their own view ownership.
const [epochs, setEpochs] = createSignal<ReadonlyMap<string, number>>(new Map())
const [sessionEpochs, setSessionEpochs] = createSignal<ReadonlyMap<string, number>>(new Map())
const [connectionEpoch, setConnectionEpoch] = createSignal<ReadonlyMap<string, number>>(new Map())
export const integrationEpoch = (instanceId: string, sessionId?: string) =>
  `${connectionEpoch().get(parseInstanceKey(instanceId).backendId) ?? 0}:${epochs().get(instanceId) ?? 0}:${sessionEpochs().get(`${instanceId}\0${sessionId ?? ""}`) ?? 0}`
const bumpConnection = (backendId: string) => setConnectionEpoch(value => new Map(value).set(backendId, (value.get(backendId) ?? 0) + 1))
const authorities = new Map<string, AbortSignal>()
const clearBackend = (backendId: string) => {
  const signal = authorities.get(backendId)
  authorities.delete(backendId)
  setConnectionEpoch(current => { const next = new Map(current); next.delete(backendId); return next })
  integrationBindings.clearBackend(backendId, signal)
}
const observeBackend = (backendId: string) => {
  const signal = serverEvents.signal(backendId)
  if (!signal) return false
  const previous = authorities.get(backendId)
  if (previous && previous !== signal) clearBackend(backendId)
  if (serverEvents.signal(backendId) !== signal || signal.aborted) return false
  authorities.set(backendId, signal)
  return true
}
serverEvents.on("*", event => { observeBackend(event.backendId ?? "local") })
const invalidate = (instanceId: string) => setEpochs(current => new Map(current).set(instanceId, (current.get(instanceId) ?? 0) + 1))
const reconnects = createEventRefreshScheduler((instanceId, signal) => signal.aborted ? undefined : integrations.refreshDemanded(instanceId))
serverEvents.on("instance.event", event => {
  if (event.type !== "instance.event") return
  const type = event.event.type
  const sessionID = (event.event as { data?: { sessionID?: unknown } }).data?.sessionID
  integrationBindings.applyEvent(event.instanceId, type, typeof sessionID === "string" ? sessionID : undefined)
  if (isIntegrationRefreshEvent(type)) {
    invalidate(event.instanceId)
    integrations.applyEvent(event.instanceId, type)
  } else if (type === "server.connected") {
    integrations.connection(event.instanceId, true)
    integrationBindings.reconnect(event.instanceId)
    invalidate(event.instanceId)
    integrations.invalidate(event.instanceId)
    reconnects.schedule(event.instanceId, "urgent", serverEvents.signalForInstance(event.instanceId))
  } else if (["session.updated", "session.deleted", "session.moved"].includes(type)) {
    const sessionID = (event.event as { data?: { sessionID?: unknown } }).data?.sessionID
    if (typeof sessionID !== "string") return
    const key = `${event.instanceId}\0${sessionID}`
    setSessionEpochs(current => new Map(current).set(key, (current.get(key) ?? 0) + 1))
  }
})
serverEvents.on("instance.eventStatus", event => {
  if (event.type !== "instance.eventStatus") return
  integrationBindings.reconnect(event.instanceId, event.status === "connected")
  integrations.connection(event.instanceId, event.status === "connected")
  invalidate(event.instanceId)
  integrations.invalidate(event.instanceId)
  if (event.status === "connected") reconnects.schedule(event.instanceId, "urgent", serverEvents.signalForInstance(event.instanceId))
})
serverEvents.onOpen(backendId => {
  if (!observeBackend(backendId)) return
  integrationBindings.reconnect(undefined, true, backendId)
  integrations.connection(undefined, true, backendId)
  bumpConnection(backendId)
  integrations.invalidate(undefined, backendId)
  void integrations.refreshDemanded(undefined, backendId)
})
serverEvents.onTransportStatus((status, backendId) => {
  if (!observeBackend(backendId)) return
  if (status !== "disconnected") return
  integrations.connection(undefined, false, backendId)
  bumpConnection(backendId)
  integrations.invalidate(undefined, backendId)
  integrationBindings.reconnect(undefined, false, backendId)
})
serverEvents.on("workspace.stopped", event => {
  if (event.type !== "workspace.stopped") return
  integrationBindings.clearInstance(event.workspaceId)
  invalidate(event.workspaceId)
  reconnects.cancel(event.workspaceId)
  integrations.clearInstance(event.workspaceId)
})
serverEvents.onDetach((backendId, signal) => {
  if (authorities.get(backendId) !== signal) return
  clearBackend(backendId)
})
