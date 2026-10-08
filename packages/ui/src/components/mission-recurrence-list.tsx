import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { MissionRecurrenceSnapshot } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { serverEvents } from "../lib/server-events"
import { MissionDisclosure } from "./mission-disclosure"

const cache = new Map<string, MissionRecurrenceSnapshot>()

export function MissionRecurrenceList(props: { instanceId: string; projectID?: string; scope: string; active: () => boolean; refresh: number }) {
  const { t } = useI18n()
  const key = () => JSON.stringify([props.instanceId, props.projectID, props.scope])
  const [snapshot, setSnapshot] = createSignal<MissionRecurrenceSnapshot>()
  const [error, setError] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [revision, setRevision] = createSignal(0)
  createEffect(() => {
    const identity = key(), initial = cache.get(identity)
    setSnapshot(initial?.projectID === props.projectID ? initial : undefined)
    setError(false)
  })
  createEffect(() => {
    revision(); props.refresh
    if (!props.active()) return
    const identity = key(), instanceId = props.instanceId, projectID = props.projectID
    const controller = new AbortController()
    let current = true
    setLoading(true)
    void serverApi.fetchMissionRecurrence(instanceId, controller.signal).then(value => {
      if (!current || controller.signal.aborted || key() !== identity || !props.active()) return
      if (value?.version !== 1 || typeof value.projectID !== "string" || !Array.isArray(value.schedules)
        || projectID && value.projectID !== projectID) { setError(true); return }
      if (cache.size >= 64 && !cache.has(identity)) cache.delete(cache.keys().next().value!)
      cache.set(identity, value); setSnapshot(value); setError(false)
    }).catch(() => { if (current && props.active()) setError(true) })
      .finally(() => { if (current) setLoading(false) })
    onCleanup(() => { current = false; controller.abort() })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefresh = () => {
    if (!props.active()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; if (props.active()) setRevision(value => value + 1) }, 50)
  }
  const changed = serverEvents.on("instance.event", event => {
    if (event.type === "instance.event" && event.instanceId === props.instanceId && props.active()
      && ["rpc.codenomad.missions.changed", "plugin.updated"].includes(event.event.type)) scheduleRefresh()
  })
  const connected = serverEvents.on("instance.eventStatus", event => {
    if (event.type === "instance.eventStatus" && event.instanceId === props.instanceId && event.status === "connected") scheduleRefresh()
  })
  const opened = serverEvents.onOpen(scheduleRefresh)
  createEffect(() => { if (!props.active() && timer) { clearTimeout(timer); timer = undefined } })
  onCleanup(() => { if (timer) clearTimeout(timer); changed(); connected(); opened() })

  return <MissionDisclosure missionId={props.scope} name="recurrence" defaultOpen title={t("missions.recurrence.list")}>
    <div class="mission-recurrence-list">
      <Show when={loading() && !snapshot()}><p role="status">{t("missions.control.loading")}</p></Show>
      <Show when={error()}><p role="status">{t(snapshot() ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
      <Show when={snapshot() && !snapshot()!.schedules.length}><p>{t("missions.recurrence.empty")}</p></Show>
      <For each={snapshot()?.schedules}>{schedule => <article class="mission-recurrence-item">
        <strong>{schedule.clock.time} · <bdi>{schedule.clock.zone}</bdi></strong>
        <small><bdi>{schedule.id}</bdi></small>
        <span>{t(`missions.recurrence.state.${schedule.state}`)}</span>
        <span>{t("missions.recurrence.settled", { count: schedule.settledCount })}</span>
        <Show when={schedule.pendingPassageID}><span>{t("missions.recurrence.pending")}</span></Show>
      </article>}</For>
    </div>
  </MissionDisclosure>
}
