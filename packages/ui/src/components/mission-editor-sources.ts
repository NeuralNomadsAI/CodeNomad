import { createEffect, createMemo, createSignal, mapArray, onCleanup, untrack } from "solid-js"
import { serverApi } from "../lib/api-client"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { buildProjectSessionListOptions } from "../stores/session-list-options"
import type { MissionConditionKind } from "./mission-scheduling-data"
import type { MissionSchedulingSourceLists } from "./mission-scheduling-sources"
import { isReservedMissionScheduleSessionID } from "../../../server/src/missions/mission-schedule-carrier-identity"

type Kind = keyof MissionSchedulingSourceLists

/** One explicitly requested source page per selected event kind, fenced to its
 * native project/location. More pages require the user's button; source reads never arm work. */
export function createMissionEditorSources(props: { instanceId: string; projectID?: string; target?: string
  directory: () => string | undefined; kinds: () => readonly MissionConditionKind[]; active: () => boolean
  captureView: () => (() => boolean) }) {
  const [sources, setSources] = createSignal<MissionSchedulingSourceLists>({})
  const [refresh, setRefresh] = createSignal(0)
  const kinds = createMemo(() => [...new Set(props.kinds().filter((kind): kind is Kind => kind !== "files-changed"))].sort(),
    [] as Kind[], { equals: (a, b) => a.join() === b.join() })
  const forget = (kind: Kind) => setSources(previous => { const { [kind]: _removed, ...rest } = previous; return rest })
  const readers = mapArray(kinds, kind => {
    const [cursor, setCursor] = createSignal<string>(), [next, setNext] = createSignal<string>()
    const [loading, setLoading] = createSignal(false), [failed, setFailed] = createSignal(false)
    let identity = ""
    createEffect(() => {
      refresh()
      const directory = props.directory(), generation = getOpenCodeInstanceGeneration(props.instanceId)
      const key = JSON.stringify([props.instanceId, props.projectID, directory, kind, generation])
      if (key !== identity) { identity = key; untrack(() => forget(kind)); setCursor(undefined); setNext(undefined) }
      const after = cursor()
      if (!props.active() || !directory) return
      const controller = new AbortController(), view = props.captureView()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
      const current = () => view() && !controller.signal.aborted && identity === key
        && generation === getOpenCodeInstanceGeneration(props.instanceId)
      setLoading(true); setFailed(false)
      const read = async () => {
        if (kind === "conversation-message") {
          const page = await getRootClient(props.instanceId).session.list(buildProjectSessionListOptions(after ? { cursor: after } : { directory }), { signal })
          if (page.data.length > 200) throw new Error("Oversized source page")
          return { rows: page.data.filter(row => !isReservedMissionScheduleSessionID(row.id)).map(row => ({ id: row.id, label: row.title || row.id })), next: page.cursor?.next }
        }
        if (kind === "branch-commits") {
          const page = await serverApi.fetchLocalGitBranches(props.instanceId, directory, signal)
          if (!Array.isArray(page.branches) || page.branches.length > 200
            || page.branches.some(ref => typeof ref !== "string" || !ref.startsWith("refs/heads/") || ref.length > 1024)) throw new Error("Invalid local branch page")
          return { rows: page.branches.map(ref => ({ id: ref, label: ref.slice("refs/heads/".length) })), next: undefined }
        }
        const page = await serverApi.fetchMissionSchedules(props.instanceId, { directory, after, limit: 8 }, signal)
        if (props.projectID && page.projectID !== props.projectID || page.schedules.length > 8) throw new Error("Foreign source page")
        return { rows: page.schedules.filter(row => row.id !== props.target && row.kind === (kind === "schedule-success" ? "schedule" : "one-time"))
          .map(row => ({ id: row.id, label: row.configuration.title })), next: page.next }
      }
      void read().then(page => {
        if (!current()) return
        untrack(() => setSources(previous => ({ ...previous, [kind]: after
          ? [...previous[kind] ?? [], ...page.rows.filter(row => !previous[kind]?.some(old => old.id === row.id))] : page.rows })))
        setNext(page.next ?? undefined)
      }).catch(() => { if (current()) { setFailed(true); untrack(() => forget(kind)) } })
        .finally(() => { if (current()) setLoading(false) })
      onCleanup(() => controller.abort())
    })
    onCleanup(() => forget(kind))
    return { next, loading, failed, more: () => setCursor(next()) }
  })
  return { sources, next: () => readers().some(reader => reader.next()), loading: () => readers().some(reader => reader.loading()),
    failed: () => readers().some(reader => reader.failed()),
    more: () => { for (const reader of readers()) if (reader.next()) reader.more() }, reload: () => setRefresh(value => value + 1) }
}
