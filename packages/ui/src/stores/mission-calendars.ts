import { createEffect, createSignal, on, onCleanup } from "solid-js"
import type { MissionCalendarView } from "../../../server/src/opencode/mission-calendars"
import { backendOf } from "../lib/backend-client"

/** The programmed Missions of one directory. One read at a time with at most one
 * trailing read; the last list stays shown while a read runs or after it fails.
 * A read that another directory, or a change made here, outdated is dropped. */
export function useMissionCalendars(props: { instanceId: () => string; directory: () => string | undefined; active: () => boolean; refresh: () => unknown }) {
  const [rows, setRows] = createSignal<MissionCalendarView[]>([])
  let identity = "", read: { trailing: boolean } | undefined
  // Another backend may answer without the list.
  const publish = (result: { calendars?: unknown }) => setRows(Array.isArray(result?.calendars) ? result.calendars as MissionCalendarView[] : [])
  const load = () => {
    if (read) { read.trailing = true; return }
    const flight = read = { trailing: false }
    void backendOf(props.instanceId()).api.missionCalendars(props.instanceId(), { directory: props.directory() }, AbortSignal.timeout(30_000))
      .then(result => { if (read === flight) publish(result) }, () => undefined)
      .finally(() => {
        if (read !== flight) return
        read = undefined
        if (flight.trailing) load()
      })
  }
  createEffect(on([props.instanceId, props.directory, props.active, props.refresh], ([instanceId, directory, active]) => {
    const next = JSON.stringify([instanceId, directory])
    if (next !== identity) { read = undefined; identity = next; setRows([]) }
    if (active) load()
  }))
  onCleanup(() => { read = undefined })
  /** Saves, pauses, resumes or deletes one programmed Mission; its answer is the list. */
  const act = async (calendar: string, change: { action: "pause" | "resume" | "delete" } | { configuration: unknown }) => {
    const owner = identity
    const result = await backendOf(props.instanceId()).api.missionCalendars(props.instanceId(), { directory: props.directory(), calendar, ...change })
    if (identity !== owner) return
    read = undefined; publish(result)
  }
  return { rows, act }
}
