import { compareEvents, type MissionCleanup, type MissionEvent } from "./model"
import { orderMissionCleanups, SETTLED_CLEANUP_HISTORY } from "./cleanup-projection"
import { missionWorkRemains } from "../opencode/missions/lifetime"
import type { MissionView } from "./journal"

/** How a mission's events name a session: its creation's coordinator or hand-off
 * author, or a task actor (independent dispatch or native binding). */
export type MissionReferenceKind = "coordinator" | "prepared-by" | "dispatching" | "native-bound"
const KINDS: readonly MissionReferenceKind[] = ["coordinator", "prepared-by", "dispatching", "native-bound"]

/** One mission range read by its journal; `uncertain` when its deletion record was unreadable. */
export interface MissionIndexRange { view: MissionView; uncertain: boolean }

/** The journal's unlocked readers; the index calls them under the append exclusion. */
export interface MissionIndexSource {
  /** Visits every mission range in key order; returns the entries outside every range. */
  scan(visit: (range: MissionIndexRange) => void): Promise<number>
  range(missionID: string): Promise<MissionIndexRange>
}

/** Valid only inside the `MissionJournal.readIndex` callback that received it. */
export interface MissionIndexReader {
  /** Every mission whose events name the session: live maps in snapshot order
   * (newest update first, ties as the snapshot breaks them), then the rest in key
   * order. A superset of membership: re-read each candidate before deciding. */
  refs(sessionID: string): Array<{ missionID: string; kinds: MissionReferenceKind[] }>
  /** Missions whose own range keeps work open (`missionWorkRemains`), in the same order. */
  openIDs(): string[]
  /** The snapshot's project values: discarded entries, damage flags and the latest live update. */
  aggregate(): { discardedEvents: number; controlUnavailable: boolean; notificationUnavailable: boolean
    cleanupUnavailable: boolean; latestUpdatedAt: number }
  /** The snapshot's cleanup projection: every pending deletion, then the newest `settled` settled ones. */
  cleanups(settled?: number): MissionCleanup[]
}

interface Entry {
  missionID: string
  refs: Map<string, MissionReferenceKind[]>
  /** The range's earliest event: the snapshot's tie order between equally updated maps. */
  first?: MissionEvent
  /** Live (non-deleted) map only. */
  updatedAt?: number
  open: boolean
  discardedEvents: number
  controlUnavailable: boolean
  notificationUnavailable: boolean
  cleanupUnavailable: boolean
  cleanups: MissionCleanup[]
}

interface State { generation: number; stray: number; entries: Map<string, Entry>; sessions: Map<string, Set<string>> }

// Every journal write in this process, per project, shared by bundle incarnations
// like the append exclusion that orders them. Isolated passage journals never count.
const registryKey = Symbol.for("codenomad.missions.journal-writes.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, number> }
const writes = host[registryKey] ??= new Map<string, number>()

/** Called under the append exclusion before every ordinary journal write attempt. */
export function noteMissionJournalWrite(projectToken: string): number {
  const generation = (writes.get(projectToken) ?? 0) + 1
  writes.set(projectToken, generation)
  return generation
}

export function missionJournalWrites(projectToken: string): number {
  return writes.get(projectToken) ?? 0
}

/**
 * One plugin activation's never-persisted view of the cross-mission facts:
 * session references, open missions, project damage and latest update, and
 * cleanup history. Built by one key-ordered scan, then kept current by the
 * journal's own writes, which mark their mission dirty (attempted, failed or
 * unconfirmed alike) so the next read re-reads that range. A write by any other
 * journal of this process shows as a foreign generation and rebuilds it; any
 * read failure drops it for a rebuild. It cannot see bytes written outside
 * `MissionJournal` (another process, earlier builds, crash remnants) after its
 * build: those exist only before an activation starts or are unsupported.
 */
export class MissionJournalIndex {
  private projectToken?: string
  private state?: State
  private readonly dirty = new Set<string>()
  private disposed = false

  attach(projectToken: string): void {
    if (this.projectToken !== undefined && this.projectToken !== projectToken) throw new Error("Mission journal index belongs to another project")
    this.projectToken = projectToken
  }

  written(missionID: string, generation: number): void {
    if (!this.state) return
    this.dirty.add(missionID)
    // Only a contiguous generation is this write's own; a gap is a foreign writer.
    if (this.state.generation === generation - 1) this.state.generation = generation
  }

  dispose(): void {
    this.disposed = true
    this.state = undefined
    this.dirty.clear()
  }

  async read<T>(source: MissionIndexSource, read: (index: MissionIndexReader) => T): Promise<T> {
    if (this.disposed || this.projectToken === undefined) throw new Error("Mission journal index unavailable")
    let state: State
    try {
      const generation = missionJournalWrites(this.projectToken)
      if (this.state?.generation !== generation) await this.build(source, generation)
      for (const missionID of [...this.dirty]) {
        const range = await source.range(missionID)
        this.apply(range)
        if (!range.uncertain) this.dirty.delete(missionID)
      }
      state = this.state!
    } catch (error) {
      this.state = undefined
      this.dirty.clear()
      throw error
    }
    let open = true
    try { return read(reader(state, () => { if (!open) throw new Error("Mission journal index read ended") })) }
    finally { open = false }
  }

  private async build(source: MissionIndexSource, generation: number): Promise<void> {
    this.state = undefined
    this.dirty.clear()
    const state: State = { generation, stray: 0, entries: new Map(), sessions: new Map() }
    const uncertain: string[] = []
    state.stray = await source.scan(range => {
      if (state.entries.has(range.view.missionID)) throw new Error("Mission journal scan is not key-ordered")
      put(state, range)
      if (range.uncertain) uncertain.push(range.view.missionID)
    })
    this.state = state
    for (const missionID of uncertain) this.dirty.add(missionID)
  }

  private apply(range: MissionIndexRange): void {
    const state = this.state!
    const previous = state.entries.get(range.view.missionID)
    for (const sessionID of previous?.refs.keys() ?? []) {
      const missions = state.sessions.get(sessionID)
      missions?.delete(range.view.missionID)
      if (!missions?.size) state.sessions.delete(sessionID)
    }
    state.entries.delete(range.view.missionID)
    put(state, range)
  }
}

function put(state: State, { view }: MissionIndexRange): void {
  const entry = entryOf(view)
  if (!entry) return
  state.entries.set(entry.missionID, entry)
  for (const sessionID of entry.refs.keys()) {
    const missions = state.sessions.get(sessionID) ?? new Set<string>()
    missions.add(entry.missionID)
    state.sessions.set(sessionID, missions)
  }
}

function entryOf(view: MissionView): Entry | undefined {
  const { events, mission } = view
  // A purged or empty range holds nothing a cross-mission question can see.
  if (!events.length && !view.discardedEvents) return undefined
  const refs = new Map<string, MissionReferenceKind[]>()
  const add = (sessionID: string, kind: MissionReferenceKind) => {
    const kinds = refs.get(sessionID) ?? []
    if (!kinds.includes(kind)) refs.set(sessionID, [...kinds, kind].sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b)))
  }
  let first: MissionEvent | undefined
  for (const event of events) {
    if (!first || compareEvents(event, first) < 0) first = event
    if (event.type === "mission.created") {
      add(event.coordinator.sessionID, "coordinator")
      if (event.preparedBy) add(event.preparedBy.coordinatorSessionID, "prepared-by")
    } else if (event.type === "task.dispatching") add(event.actor.sessionID, "dispatching")
    else if (event.type === "task.native-bound") add(event.actor.sessionID, "native-bound")
  }
  return {
    missionID: view.missionID, refs, first, ...(mission ? { updatedAt: mission.updatedAt } : {}),
    open: missionWorkRemains({ ...view, missions: mission ? [mission] : [] }),
    discardedEvents: view.discardedEvents, controlUnavailable: Boolean(view.controlUnavailable),
    notificationUnavailable: Boolean(view.notificationUnavailable), cleanupUnavailable: Boolean(view.cleanupUnavailable),
    cleanups: view.cleanups ?? [],
  }
}

/** The snapshot's map order, extended to maps it does not list. */
function compareEntries(left: Entry, right: Entry): number {
  if ((left.updatedAt === undefined) !== (right.updatedAt === undefined)) return left.updatedAt === undefined ? 1 : -1
  const order = left.updatedAt === undefined || right.updatedAt === undefined ? 0
    : right.updatedAt - left.updatedAt || compareEvents(left.first!, right.first!)
  // Full ties keep the scan's binary key order, never locale order.
  return order || (`${left.missionID}/` < `${right.missionID}/` ? -1 : 1)
}

function reader(state: State, live: () => void): MissionIndexReader {
  const entries = () => [...state.entries.values()]
  return {
    refs: sessionID => {
      live()
      return [...state.sessions.get(sessionID) ?? []].map(missionID => state.entries.get(missionID)!).sort(compareEntries)
        .map(entry => ({ missionID: entry.missionID, kinds: [...entry.refs.get(sessionID)!] }))
    },
    openIDs: () => {
      live()
      return entries().filter(entry => entry.open).sort(compareEntries).map(entry => entry.missionID)
    },
    aggregate: () => {
      live()
      const damaged = state.stray > 0
      const result = { discardedEvents: state.stray, controlUnavailable: damaged, notificationUnavailable: damaged,
        cleanupUnavailable: damaged, latestUpdatedAt: 0 }
      for (const entry of state.entries.values()) {
        result.discardedEvents += entry.discardedEvents
        result.controlUnavailable ||= entry.controlUnavailable
        result.notificationUnavailable ||= entry.notificationUnavailable
        result.cleanupUnavailable ||= entry.cleanupUnavailable
        if (entry.updatedAt !== undefined) result.latestUpdatedAt = Math.max(result.latestUpdatedAt, entry.updatedAt)
      }
      return result
    },
    cleanups: (settled = SETTLED_CLEANUP_HISTORY) => {
      live()
      return orderMissionCleanups(entries().flatMap(entry => entry.cleanups.map(cleanup => ({ ...cleanup, reasons: [...cleanup.reasons] }))), settled)
    },
  }
}
