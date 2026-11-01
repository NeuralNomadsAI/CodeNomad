import { createSignal, type Accessor, type Setter } from "solid-js"
import type { MissionBodyDescriptor, MissionContentResponse, MissionContentSelector } from "../../../server/src/missions/mission-content-wire"
import { validMissionContentSlice } from "../lib/mission-content-slice"

/** One mission body: the mission it belongs to, where, and its selector. */
export interface MissionBodyRef { instanceId: string; projectID: string; missionID: string; selector: MissionContentSelector }
/** A body's text from offset 0, cut from exactly one digest: never two values joined.
 * `mark`: the owner metadata it was read under (`MissionBodyConsumer.version`). */
export interface MissionBody { digest: string; revision: number; characters: number; json: boolean; text: string; mark?: string }
/** `error`: the last read failed, a plugin without content reads included. */
export type MissionBodyStatus = "loading" | "ready" | "missing" | "error"
/** `revision`: the mission revision of the last accepted answer. */
export interface MissionBodyState { status: MissionBodyStatus; body?: MissionBody; revision?: number }

export type MissionContentFetch = (ref: MissionBodyRef, query: { digest?: string; offset: number }, signal: AbortSignal) => Promise<MissionContentResponse>

export interface MissionBodyConsumer {
  state: Accessor<MissionBodyState>
  /** The prefix this consumer shows, in characters; `Infinity` for the whole value. */
  need(characters: number): void
  /** The body this consumer's map shows: its descriptor at the map's revision. A shown
   * body of another digest is read again; the newest map wins. A map naming no such
   * body (no descriptor) expects nothing. */
  expect(descriptor: MissionBodyDescriptor | undefined, revision: number | undefined): void
  /** For a body no descriptor describes (an older plugin's map): the mark its owner's
   * metadata gives it now. A body held, or a read sent, under another mark is read again;
   * undefined asks nothing. */
  version(mark: string | undefined): void
  retry(): void
  release(): void
}

/** Bodies no reader shows stay for an immediate redisplay within this many bytes
 * (UTF-16), least recently used first out; shown bodies are never evicted. */
export const MISSION_BODY_CACHE_BYTES = 4 * 1024 * 1024
const MAX_RETAINED_BODIES = 128
/** Consecutive restarts (a `content-changed` refusal, or a first slice older than the map
 * that names its body) before a read fails instead of chasing the value. */
const MAX_RESTARTS = 4

interface Entry {
  key: string
  ref: MissionBodyRef
  identity: string
  state: Accessor<MissionBodyState>
  publish: Setter<MissionBodyState>
  status: MissionBodyStatus
  /** What readers show: the last good body, kept while a newer one loads. */
  display?: MissionBody
  /** A newer digest, shown once it covers what the readers need. */
  pending?: MissionBody
  /** The mission revision of the last accepted answer. */
  answered?: number
  /** The body the newest map shown by a reader names. */
  expected?: { revision: number; digest: string }
  /** The mark readers ask the body to be read under (`version`), the mark of the read in
   * flight, and the mark of the last missing answer. */
  mark?: string
  sentMark?: string
  missingMark?: string
  /** Counts recovery invalidations: an answer to a read sent before the latest is superseded. */
  epoch: number
  stale: boolean
  /** A failed read waits for new demand, an invalidation or an explicit retry. */
  parked: boolean
  restarts: number
  consumers: Map<symbol, { need: number }>
  controller?: AbortController
  used: number
}

const keyOf = (ref: MissionBodyRef) => JSON.stringify([ref.instanceId, ref.projectID, ref.missionID, ref.selector.kind, ref.selector.field,
  "taskKey" in ref.selector ? ref.selector.taskKey : "reportId" in ref.selector ? ref.selector.reportId : "change" in ref.selector ? ref.selector.change : null])

/** The display cache of mission bodies read through the content route, per workspace,
 * project, mission and selector, each continuation pinned by its digest. */
export function createMissionContentStore(fetch: MissionContentFetch, budget = MISSION_BODY_CACHE_BYTES) {
  const entries = new Map<string, Entry>()
  let tick = 0

  const need = (entry: Entry) => Math.max(1, ...[...entry.consumers.values()].map(consumer => consumer.need))
  const covers = (body: MissionBody, characters: number) => body.text.length >= Math.min(characters, body.characters)
  const publish = (entry: Entry) => entry.publish({ status: entry.status, ...(entry.display ? { body: entry.display } : {}),
    ...(entry.answered === undefined ? {} : { revision: entry.answered }) })
  /** Whether an answer (its digest, none for a missing body, and revision) is the body the
   * newest map names, or newer than that map: a map catches up with a later answer. */
  const satisfies = (entry: Entry, digest: string | undefined, revision: number | undefined) => {
    const expected = entry.expected
    return !expected || digest === expected.digest || (revision ?? 0) >= expected.revision
  }
  /** Whether an answer read under `mark` is read under the mark readers ask for, if any. */
  const marked = (entry: Entry, mark: string | undefined) => entry.mark === undefined || mark === entry.mark
  /** Whether what the entry holds is the body the newest map names (or nothing is held yet). */
  const fresh = (entry: Entry) => {
    if (entry.status === "missing") return satisfies(entry, undefined, entry.answered) && marked(entry, entry.missingMark)
    const body = entry.pending ?? entry.display
    return !body || satisfies(entry, body.digest, body.revision) && marked(entry, body.mark)
  }

  const cancel = (entry: Entry) => {
    entry.controller?.abort()
    entry.controller = undefined
  }
  const drop = (entry: Entry) => {
    cancel(entry)
    if (entries.get(entry.key) === entry) entries.delete(entry.key)
  }
  const evict = () => {
    const idle = [...entries.values()].filter(entry => !entry.consumers.size).sort((left, right) => left.used - right.used)
    let bytes = idle.reduce((total, entry) => total + 2 * ((entry.display?.text.length ?? 0) + (entry.pending?.text.length ?? 0)), 0)
    for (const [index, entry] of idle.entries()) {
      if (bytes <= budget && idle.length - index <= MAX_RETAINED_BODIES) break
      bytes -= 2 * ((entry.display?.text.length ?? 0) + (entry.pending?.text.length ?? 0))
      drop(entry)
    }
  }

  const promote = (entry: Entry) => {
    if (entry.pending && (!entry.display || covers(entry.pending, need(entry)))) {
      entry.display = entry.pending
      entry.pending = undefined
    }
  }

  const accept = (entry: Entry, query: { digest?: string; offset: number }, response: MissionContentResponse, mark: string | undefined) => {
    if (!response || typeof response !== "object") throw new Error("Invalid mission content")
    // A first answer older than the body its map names is read again, within the restart bound.
    const settle = (digest: string | undefined, revision: number | undefined) => {
      if (satisfies(entry, digest, revision)) { entry.stale = false; return }
      if (++entry.restarts > MAX_RESTARTS) throw new Error("Mission content predates its map")
      entry.stale = true
    }
    // Unavailable (a plugin without content reads included): a failure, parked until
    // new demand, an invalidation (a plugin update) or Retry.
    if (response.available === false) {
      entry.status = "error"
      entry.parked = true
      entry.pending = undefined
      entry.stale = false
      return
    }
    if (response.version !== 1 || response.projectID !== entry.ref.projectID || response.missionID !== entry.ref.missionID) throw new Error("Foreign mission content")
    if ("refused" in response) {
      if (response.refused === "content-changed" && query.offset > 0) {
        if (++entry.restarts > MAX_RESTARTS) throw new Error("Mission content keeps changing")
        entry.pending = undefined
        entry.stale = true
        return
      }
      if (response.refused !== "mission-not-found" && response.refused !== "content-not-found") throw new Error("Invalid mission content")
      entry.display = entry.pending = undefined
      entry.answered = response.revision ?? entry.answered
      entry.missingMark = mark
      entry.status = "missing"
      settle(undefined, response.revision)
      return
    }
    const slice = validMissionContentSlice(entry.ref.selector, query, response.content)
    if (!Number.isSafeInteger(response.revision)) throw new Error("Invalid mission content")
    const revision = response.revision!
    entry.answered = Math.max(entry.answered ?? 0, revision)
    entry.status = "ready"
    if (query.offset === 0) {
      settle(slice.digest, revision)
      const body = { digest: slice.digest, revision, characters: slice.characters, json: slice.json === true, text: slice.text, ...(mark === undefined ? {} : { mark }) }
      if (entry.display?.digest === body.digest) {
        entry.display = { ...entry.display, revision, ...(mark === undefined ? {} : { mark }), text: entry.display.text.length >= body.text.length ? entry.display.text : body.text }
        entry.pending = undefined
      } else entry.pending = body
    } else {
      const owner = entry.pending?.digest === slice.digest ? "pending" : entry.display?.digest === slice.digest ? "display" : undefined
      const body = owner && entry[owner]
      // Only the body this slice continues, at exactly its end, ever grows.
      if (!owner || !body || body.text.length !== slice.offset) return
      entry[owner] = { ...body, revision: Math.max(body.revision, revision), text: body.text + slice.text }
    }
    promote(entry)
    if (!entry.pending && entry.display && covers(entry.display, need(entry)) && fresh(entry)) entry.restarts = 0
  }

  const read = (entry: Entry, query: { digest?: string; offset: number }) => {
    const controller = new AbortController(), epoch = entry.epoch, mark = entry.mark
    entry.controller = controller
    entry.sentMark = mark
    // A read after a failure shows the body it reads for, never the failure it retries.
    if (entry.status === "error") { entry.status = entry.display ? "ready" : "loading"; publish(entry) }
    // A late answer for a released, replaced or switched entry never publishes; one sent
    // before a recovery invalidation leaves that invalidation's fresh read to come.
    const admitted = () => entry.controller === controller && !controller.signal.aborted && entries.get(entry.key) === entry && entry.epoch === epoch
    void fetch(entry.ref, query, controller.signal).then(response => {
      if (!admitted()) return
      accept(entry, query, response, mark)
      publish(entry)
    }).catch(() => {
      if (!admitted()) return
      entry.status = "error"
      entry.parked = true
      entry.pending = undefined
      publish(entry)
    }).finally(() => {
      if (entry.controller !== controller) return
      entry.controller = undefined
      pump(entry)
      evict()
    })
  }

  /** One read at a time per body; demand that arrives meanwhile is served when it settles. */
  function pump(entry: Entry) {
    if (entry.controller || !entry.consumers.size || entry.parked || entries.get(entry.key) !== entry) return
    // A map that named another body while a read ran is served now.
    if (!fresh(entry)) entry.stale = true
    const shown = entry.pending ?? entry.display
    if (entry.stale || !shown) {
      if (!entry.stale && entry.status === "missing") return
      read(entry, { offset: 0 })
    } else if (!covers(shown, need(entry))) read(entry, { digest: shown.digest, offset: shown.text.length })
  }

  /** `mark`: the first `version` of a body no descriptor describes, so its first read is sent under it. */
  const use = (ref: MissionBodyRef, identity: string, mark?: string): MissionBodyConsumer => {
    const key = keyOf(ref)
    let entry = entries.get(key)
    // Another instance connection, folder or native generation never shows this body.
    if (entry && entry.identity !== identity) { drop(entry); entry = undefined }
    if (!entry) {
      const [state, setState] = createSignal<MissionBodyState>({ status: "loading" })
      entry = { key, ref, identity, state, publish: setState, status: "loading", epoch: 0, stale: false, parked: false, restarts: 0, consumers: new Map(), used: 0 }
      entries.set(key, entry)
    }
    if (mark !== undefined) entry.mark = mark
    const owner = entry, id = Symbol(key)
    owner.consumers.set(id, { need: 1 })
    owner.used = ++tick
    // New demand retries a parked failure.
    if (owner.parked) { owner.parked = false; owner.stale = true }
    pump(owner)
    return {
      state: owner.state,
      need: characters => {
        const consumer = owner.consumers.get(id)
        if (!consumer || consumer.need === characters) return
        consumer.need = characters
        promote(owner)
        publish(owner)
        pump(owner)
      },
      expect: (descriptor, revision) => {
        if (!descriptor || revision === undefined || !owner.consumers.has(id)) return
        const expected = owner.expected
        if (expected && (revision < expected.revision || revision === expected.revision && descriptor.digest === expected.digest)) return
        owner.expected = { revision, digest: descriptor.digest }
        // A read in flight checks the newest map when it settles.
        if (owner.controller || owner.stale || owner.status === "loading" || fresh(owner)) return
        owner.stale = true
        owner.parked = false
        pump(owner)
      },
      version: mark => {
        if (!owner.consumers.has(id) || mark === owner.mark) return
        owner.mark = mark
        if (mark === undefined) return
        // A read sent under another mark is superseded: its answer never publishes, and one
        // fresh read follows it. A body held under another mark is read again.
        if (owner.controller) {
          if (owner.sentMark !== mark) { owner.epoch++; owner.stale = true }
          return
        }
        if (fresh(owner)) return
        owner.stale = true
        owner.parked = false
        pump(owner)
      },
      retry: () => {
        if (!owner.consumers.has(id) || owner.controller) return
        owner.stale = true
        owner.parked = false
        owner.restarts = 0
        pump(owner)
      },
      release: () => {
        if (!owner.consumers.delete(id) || owner.consumers.size) return
        owner.used = ++tick
        cancel(owner)
        if (!owner.display) drop(owner)
        evict()
      },
    }
  }

  return {
    use,
    /** Every body of `instanceId` (or all) is read again when shown: a plugin reload, a
     * reconnect or a new event stream. A read already running is superseded: its answer
     * neither settles nor parks the body, and one fresh read follows it. */
    invalidate(instanceId?: string) {
      for (const entry of entries.values()) if (instanceId === undefined || entry.ref.instanceId === instanceId) {
        entry.epoch++
        entry.stale = true
        entry.parked = false
        pump(entry)
      }
    },
    /** Drops every body of `instanceId` (or all): a stopped workspace. */
    clear(instanceId?: string) {
      for (const entry of [...entries.values()]) if (instanceId === undefined || entry.ref.instanceId === instanceId) {
        drop(entry)
        entry.display = entry.pending = entry.answered = undefined
        entry.status = "error"
        publish(entry)
      }
    },
    /** Bytes held by bodies no reader shows. */
    retainedBytes: () => [...entries.values()].filter(entry => !entry.consumers.size)
      .reduce((total, entry) => total + 2 * ((entry.display?.text.length ?? 0) + (entry.pending?.text.length ?? 0)), 0),
  }
}
