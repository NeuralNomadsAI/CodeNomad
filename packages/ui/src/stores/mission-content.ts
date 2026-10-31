import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import { missionBodyDescriptor, type MissionBodyDescriptor, type MissionContentSelector } from "../../../server/src/missions/mission-content-wire"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { instances } from "./instances"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { createMissionContentStore, type MissionBodyConsumer, type MissionBodyRef, type MissionBodyState } from "./mission-content-store"

export const missionContent = createMissionContentStore((ref, query, signal) =>
  serverApi.fetchMissionContent(ref.instanceId, ref.missionID, { ...ref.selector, ...query }, signal))

/** A body a reader shows, the revision of the map it was chosen from and that map's
 * descriptor of it (absent from a map without descriptors). */
export interface MissionBodySource { ref: MissionBodyRef; revision: number; descriptor?: MissionBodyDescriptor }

export function missionBodySource(instanceId: string, mission: MissionMap, selector: MissionContentSelector): MissionBodySource {
  const descriptor = missionBodyDescriptor(mission, selector)
  return { ref: { instanceId, projectID: mission.projectID, missionID: mission.id, selector }, revision: mission.revision, ...(descriptor ? { descriptor } : {}) }
}

const clients = new WeakMap<object, number>()
let clientCount = 0
/** The connection a body is read through; a body read through another is never shown. */
function connection(instanceId: string): string {
  const instance = instances().get(instanceId), client = instance?.client as object | undefined
  if (client && !clients.has(client)) clients.set(client, ++clientCount)
  return JSON.stringify([instance?.folder, client ? clients.get(client) : 0, getOpenCodeInstanceGeneration(instanceId)])
}

/** One shown body: demand follows `source` (undefined releases it) and `need`, the
 * prefix in characters the reader shows. Only identity changes re-register demand. */
export function useMissionBody(source: () => MissionBodySource | undefined, need: () => number = () => Infinity) {
  const binding = createMemo(() => {
    const value = source()
    return value ? JSON.stringify([connection(value.ref.instanceId), value.ref]) : undefined
  })
  const [consumer, setConsumer] = createSignal<MissionBodyConsumer>()
  createEffect(() => {
    const value = binding()
    if (!value) { setConsumer(undefined); return }
    const [identity, ref] = JSON.parse(value) as [string, MissionBodyRef]
    const handle = untrack(() => missionContent.use(ref, identity))
    setConsumer(() => handle)
    onCleanup(() => handle.release())
  })
  createEffect(() => { const handle = consumer(), characters = need(); if (handle) untrack(() => handle.need(characters)) })
  createEffect(() => {
    const handle = consumer(), value = source()
    if (handle) untrack(() => handle.expect(value?.descriptor, value?.revision))
  })
  return {
    state: (): MissionBodyState => consumer()?.state() ?? { status: "loading" },
    retry: () => consumer()?.retry(),
  }
}

/** A body shown whole (lists, artifacts, briefings, edited fields): `fallback`, the map's
 * own value, from a plugin without content reads, else its value once every slice of one
 * digest is read, JSON parsed. `settled` is false until then; `failed` reports a failed
 * read even while the last good value stays shown. */
export function useMissionBodyValue<T>(source: () => (MissionBodySource & { fallback: () => T }) | undefined) {
  const read = useMissionBody(source)
  const resolved = createMemo<{ value: T | undefined } | undefined>(() => {
    const state = read.state(), body = state.body
    if (state.status === "unsupported") return { value: source()?.fallback() }
    if (state.status === "missing") return { value: undefined }
    if (body && body.text.length === body.characters) {
      try { return { value: (body.json ? JSON.parse(body.text) : body.text) as T } } catch { return undefined }
    }
    return undefined
  })
  return {
    value: () => resolved()?.value,
    settled: () => resolved() !== undefined,
    failed: () => read.state().status === "error",
    retry: read.retry,
  }
}

serverEvents.on("instance.event", event => {
  if (event.type === "instance.event" && event.event.type === "plugin.updated") missionContent.invalidate(event.instanceId)
})
serverEvents.on("instance.eventStatus", event => {
  if (event.type === "instance.eventStatus" && event.status === "connected") missionContent.invalidate(event.instanceId)
})
serverEvents.onOpen(() => missionContent.invalidate())
serverEvents.on("workspace.stopped", event => {
  if (event.type === "workspace.stopped") missionContent.clear(event.workspaceId)
})
