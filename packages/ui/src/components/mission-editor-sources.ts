import { createEffect, createMemo, createSignal, mapArray, on, onCleanup, untrack } from "solid-js"
import { backendOf } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { buildProjectSessionListOptions, normalizeSessionDirectory } from "../stores/session-list-options"
import type { MissionConditionKind } from "./mission-scheduling-data"
import type { MissionSchedulingSourceLists } from "./mission-scheduling-sources"
import { isReservedMissionScheduleSessionID } from "../../../server/src/missions/mission-schedule-carrier-identity"
import { backgroundReads } from "../lib/background-read-queue"
import { isMissionGithubKind } from "../../../server/src/missions/mission-github-condition"

type Kind = keyof MissionSchedulingSourceLists

// Native title matching folds ASCII only. Narrow by a case-stable substring;
// the picker matches the complete query locally, including accented letter case.
function conversationTitleQuery(query: string): string {
  const characters = Array.from(query)
  // K lowercases to ASCII k; İ adds i + a combining dot. Keep those possible
  // lowercase outputs out of the native candidate, including a terminal i.
  return characters.map((character, index) => {
    const lower = character.toLowerCase()
    const stable = (character.codePointAt(0)! < 128 || lower === character.toUpperCase())
      && lower !== "k" && character !== "\u0307" && !(lower === "i" && (index === characters.length - 1 || characters[index + 1] === "\u0307"))
    return stable ? character : "\0"
  }).join("").split("\0").reduce((best, part) => part.trim().length > best.length ? part.trim() : best, "")
}

/** Bounded source pages per selected event kind. Open source pickers own continuation. */
export function createMissionEditorSources(props: { instanceId: string; projectID?: string; target?: string
  directory: () => string | undefined; kinds: () => readonly (MissionConditionKind | "coordinator-session")[]; active: () => boolean
  selected: () => readonly { kind: Kind; id: string }[]
  captureView: () => (() => boolean) }) {
  const [sources, setSources] = createSignal<MissionSchedulingSourceLists>({})
  const kinds = createMemo(() => [...new Set(props.kinds().filter((kind): kind is Kind => kind !== "files-changed" && kind !== "repository-activity" && !isMissionGithubKind(kind)))].sort(),
    [] as Kind[], { equals: (a, b) => a.join() === b.join() })
  const forget = (kind: Kind) => setSources(previous => { const { [kind]: _removed, ...rest } = previous; return rest })
  const readers = mapArray(kinds, kind => {
    const [refresh, setRefresh] = createSignal(0)
    const [cursor, setCursor] = createSignal<string>(), [next, setNext] = createSignal<string>()
    const [search, setSearch] = createSignal("")
    const [loading, setLoading] = createSignal(false), [failed, setFailed] = createSignal(false)
    const [pins, setPins] = createSignal<readonly { id: string; label: string }[]>([])
    const [pinLoading, setPinLoading] = createSignal<ReadonlySet<string>>(new Set()), [pinFailed, setPinFailed] = createSignal<ReadonlySet<string>>(new Set())
    const identity = createMemo(() => JSON.stringify([props.instanceId, props.projectID, props.directory(), kind,
      getOpenCodeInstanceGeneration(props.instanceId)]))
    const active = createMemo(() => props.active() && !!props.directory())
    const selected = createMemo(() => [...new Set(props.selected().filter(item => item.kind === kind).map(item => item.id))].sort(),
      [] as string[], { equals: (a, b) => a.join() === b.join() })
    let pinIdentity = "", previous = "", previousOwner = ""
    createEffect(on([identity, active, selected, refresh], ([key, enabled]) => {
      if (key !== pinIdentity) { pinIdentity = key; setPins([]) }
      const ids = selected().filter(id => !(previousOwner === key && sources()[kind]?.some(row => row.id === id)) && !pins().some(row => row.id === id))
      if (!enabled || !ids.length || kind === "branch-commits") { setPinLoading(new Set<string>()); setPinFailed(new Set<string>()); return }
      const controller = new AbortController(), view = props.captureView(), directory = props.directory()!
      const operation = captureBackendOperation(props.instanceId, controller.signal)
      const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)])
      const current = () => operation.current() && view() && identity() === key && !controller.signal.aborted
      setPinLoading(new Set(ids)); setPinFailed(new Set<string>())
      void Promise.allSettled(ids.map(id => backgroundReads.run(signal, async () => {
        if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(id)) throw new Error("Invalid source")
        if (id === props.target) throw new Error("Source cycle")
        if (kind === "conversation-message" || kind === "coordinator-session") {
          const source = await getRootClient(props.instanceId).session.get({ sessionID: id }, { signal })
          if (source.id !== id || props.projectID && source.projectID !== props.projectID
            || normalizeSessionDirectory(source.location.directory) !== normalizeSessionDirectory(directory)
            || isReservedMissionScheduleSessionID(id) || kind === "coordinator-session" && source.parentID) throw new Error("Foreign source")
          return { id, label: source.title || id }
        }
        const read = await backendOf(props.instanceId).api.fetchMissionSchedule(props.instanceId, id, { directory }, signal), { document } = read
        if (!document || document.id !== id
          || !document.configuration.roots.some(root => normalizeSessionDirectory(root.directory) === normalizeSessionDirectory(directory))
          || document.kind !== (kind === "schedule-success" ? "schedule" : "one-time")) throw new Error("Source unavailable")
        return { id, label: document.configuration.title }
      }))).then(results => {
        if (!current()) return
        const rows = results.flatMap(result => !signal.aborted && result.status === "fulfilled" ? [result.value] : [])
        setPins(previous => [...previous.filter(row => !rows.some(next => next.id === row.id)), ...rows])
        setPinFailed(new Set(results.flatMap((result, index) => signal.aborted || result.status === "rejected" ? [ids[index]] : [])))
        setPinLoading(new Set<string>())
      })
      onCleanup(() => controller.abort())
    }))
    createEffect(on([identity, active, cursor, refresh, search], ([key, enabled]) => {
      const directory = props.directory(), generation = getOpenCodeInstanceGeneration(props.instanceId)
      const query = search(), requestKey = JSON.stringify([key, query])
      if (requestKey !== previous) {
        const paged = cursor() !== undefined
        if (previousOwner === key) {
          const known = sources()[kind]?.filter(row => selected().includes(row.id)) ?? []
          setPins(previous => [...previous.filter(row => !known.some(next => next.id === row.id)), ...known])
        }
        previous = requestKey; previousOwner = key
        untrack(() => forget(kind)); setCursor(undefined); setNext(undefined)
        if (paged) return
      }
      const after = cursor()
      if (!enabled || !directory) { setLoading(false); return }
      const controller = new AbortController(), view = props.captureView()
      const operation = captureBackendOperation(props.instanceId, controller.signal)
      const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)])
      const current = () => operation.current() && view() && !controller.signal.aborted && identity() === key
        && search() === query
        && generation === getOpenCodeInstanceGeneration(props.instanceId)
      setLoading(true); setFailed(false)
      const read = async () => {
        signal.throwIfAborted()
        if (kind === "conversation-message" || kind === "coordinator-session") {
          const page = await getRootClient(props.instanceId).session.list(buildProjectSessionListOptions(after ? { cursor: after }
            : { directory, search: conversationTitleQuery(query), order: "desc", ...(kind === "coordinator-session" ? { parentID: null } : {}) }), { signal })
          if (page.data.length > 200) throw new Error("Oversized source page")
          return { rows: page.data.filter(row => !isReservedMissionScheduleSessionID(row.id) && (kind !== "coordinator-session"
            || !row.parentID && (!props.projectID || row.projectID === props.projectID)
              && normalizeSessionDirectory(row.location.directory) === normalizeSessionDirectory(directory)))
            .map(row => ({ id: row.id, label: row.title || row.id })), next: page.cursor?.next }
        }
        if (kind === "branch-commits") {
          const page = await backendOf(props.instanceId).api.fetchLocalGitBranches(props.instanceId, directory, signal)
          if (!Array.isArray(page.branches) || page.branches.length > 200
            || page.branches.some(ref => typeof ref !== "string" || !ref.startsWith("refs/heads/") || ref.length > 1024)) throw new Error("Invalid local branch page")
          return { rows: page.branches.map(ref => ({ id: ref, label: ref.slice("refs/heads/".length) })), next: undefined }
        }
        const page = await backendOf(props.instanceId).api.fetchMissionSchedules(props.instanceId, { directory, after, limit: 8 }, signal)
        if (props.projectID && page.projectID !== props.projectID || page.schedules.length > 8) throw new Error("Foreign source page")
        return { rows: page.schedules.filter(row => row.id !== props.target && row.kind === (kind === "schedule-success" ? "schedule" : "one-time"))
          .map(row => ({ id: row.id, label: row.configuration.title })), next: page.next }
      }
      const timer = setTimeout(() => { void read().then(page => {
        if (!current()) return
        if (page.next && page.next === after) throw new Error("Source cursor did not advance")
        untrack(() => setSources(previous => ({ ...previous, [kind]: after
          ? [...previous[kind] ?? [], ...page.rows.filter(row => !previous[kind]?.some(old => old.id === row.id))] : page.rows })))
        setNext(page.next ?? undefined)
      }).catch(() => { if (current()) setFailed(true) })
       .finally(() => { if (current()) setLoading(false) }) }, (kind === "conversation-message" || kind === "coordinator-session") && query ? 200 : 0)
      onCleanup(() => { clearTimeout(timer); controller.abort() })
    }))
    onCleanup(() => forget(kind))
    return { kind, next, pins, pinLoading, pinFailed, loading, failed, more: () => { if (next() && !loading() && !failed()) setCursor(next()) },
      retry: () => setRefresh(value => value + 1), search: kind === "conversation-message" || kind === "coordinator-session" ? (value: string) => setSearch(value.trim()) : undefined }
  })
  const choices = createMemo(() => {
    const result = { ...sources() }
    for (const reader of readers()) if (reader.pins().length) result[reader.kind] = [...result[reader.kind] ?? [],
      ...reader.pins().filter(pin => !result[reader.kind]?.some(row => row.id === pin.id))]
    return result
  })
  return { sources: choices, loading: () => readers().some(reader => reader.loading() || reader.pinLoading().size > 0), reader: (kind: Kind, value = "") => {
    const reader = readers().find(reader => reader.kind === kind)
    return reader && { next: reader.next, failed: reader.failed, more: reader.more, retry: reader.retry, search: reader.search,
      loading: () => reader.loading() || reader.pinLoading().has(value), lookupFailed: () => reader.pinFailed().has(value) }
  } }
}
