import { createSignal } from "solid-js"
import { fetchIntegrationBinding, fetchIntegrations } from "../lib/integrations-api"
import { createIntegrationBindingsStore } from "./integration-bindings-store"
import { createEventRefreshScheduler } from "../lib/event-refresh-scheduler"
import { serverEvents } from "../lib/server-events"
import { createIntegrationsStore, isIntegrationRefreshEvent } from "./integrations-store"

export const integrations = createIntegrationsStore(fetchIntegrations)
export const integrationBindings = createIntegrationBindingsStore(fetchIntegrationBinding)
// Invalidates live offer snapshots, including across reconnects. Action receipts have their own view ownership.
const [epochs, setEpochs] = createSignal<ReadonlyMap<string, number>>(new Map())
const [sessionEpochs, setSessionEpochs] = createSignal<ReadonlyMap<string, number>>(new Map())
const [connectionEpoch, setConnectionEpoch] = createSignal(0)
export const integrationEpoch = (instanceId: string, sessionId?: string) =>
  `${connectionEpoch()}:${epochs().get(instanceId) ?? 0}:${sessionEpochs().get(`${instanceId}\0${sessionId ?? ""}`) ?? 0}`
const invalidate = (instanceId: string) => setEpochs(current => new Map(current).set(instanceId, (current.get(instanceId) ?? 0) + 1))
const reconnects = createEventRefreshScheduler(instanceId => integrations.refreshDemanded(instanceId))
serverEvents.on("instance.event", event => {
  if (event.type !== "instance.event") return
  const type = event.event.type
  const sessionID = (event.event as { data?: { sessionID?: unknown } }).data?.sessionID
  integrationBindings.applyEvent(event.instanceId, type, typeof sessionID === "string" ? sessionID : undefined)
  if (isIntegrationRefreshEvent(type)) {
    invalidate(event.instanceId)
    integrations.applyEvent(event.instanceId, type)
  } else if (type === "server.connected") {
    integrationBindings.reconnect(event.instanceId)
    invalidate(event.instanceId)
    integrations.invalidate(event.instanceId)
    reconnects.schedule(event.instanceId, "urgent")
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
  invalidate(event.instanceId)
  integrations.invalidate(event.instanceId)
  if (event.status === "connected") reconnects.schedule(event.instanceId, "urgent")
})
serverEvents.onOpen(() => {
  integrationBindings.reconnect()
  setConnectionEpoch(value => value + 1)
  integrations.invalidate()
  void integrations.refreshDemanded()
})
serverEvents.onTransportStatus(status => {
  if (status !== "disconnected") return
  setConnectionEpoch(value => value + 1)
  integrations.invalidate()
  integrationBindings.reconnect(undefined, false)
})
serverEvents.on("workspace.stopped", event => {
  if (event.type !== "workspace.stopped") return
  integrationBindings.clearInstance(event.workspaceId)
  invalidate(event.workspaceId)
  reconnects.cancel(event.workspaceId)
  integrations.clearInstance(event.workspaceId)
})
