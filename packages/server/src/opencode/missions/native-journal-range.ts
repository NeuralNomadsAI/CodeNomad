import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { MISSION_JOURNAL_STORAGE_PREFIX, parseMissionEvent } from "../../missions/journal"
import { compareEvents, orderedMissionLookups, type MissionEvent } from "../../missions/model"
import { stableToken } from "../../missions/receipt-identity"
import { cleanupReceiptID, documentCleanupReceiptID } from "../../missions/cleanup-projection"
import type { NativeMissionDocumentRunner } from "./native-mission-document-storage"
import { journalHeadSQL } from "./native-journal-head"

const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const clientSchema = Schema.declare<SqlClient.SqlClient>((value): value is SqlClient.SqlClient => Predicate.isFunction(value)
  && Predicate.hasProperty(value, "unsafe") && Predicate.isFunction(value.unsafe))
const method = Schema.declare<(...args: never[]) => Effect.Effect<unknown, unknown>>(
  (value): value is (...args: never[]) => Effect.Effect<unknown, unknown> => Predicate.isFunction(value))
const shape = Schema.Struct({ db: Schema.Struct({ $client: clientSchema, transaction: method }) })
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const ns = `plugin:${Buffer.from("codenomad.missions", "utf16le").swap16().toString("hex")}:`
const safeKey = /^[A-Za-z0-9_-]{3,100}$/
const BATCH_ROWS = 128
const BATCH_BYTES = 1024 * 1024

type NativeDatabase = { db: { $client: SqlClient.SqlClient
  transaction<A>(callback: () => Effect.Effect<A, unknown>,
     config: { behavior: "deferred" | "immediate" }): Effect.Effect<A, unknown> } }

export interface NativeJournalRangeObservation {
  /** Exact observation fence for the physical range, including malformed rows. */
  digest: string
  discardedEvents: number
  rows: number
  /** UTF-8 body bytes stored in the range, not physical disk I/O. */
  bytes: number
}

export interface NativeJournalRange {
  /** Fold only in this synchronous visitor; publish/use results only after the call resolves. */
  readOrdered(missionID: string, visit: (batch: readonly MissionEvent[], related: ReadonlyMap<string, MissionEvent>,
    reports: ReadonlyMap<string, MissionEvent>) => void, prepare?: (observed: NativeJournalRangeObservation,
    created: Extract<MissionEvent, { type: "mission.created" }> | undefined) => boolean,
    cachedDigest?: string, advance?: (event: MissionEvent) => boolean): Promise<NativeJournalRangeObservation>
  listRanges(): Promise<{ missionIDs: string[]; stray: number }>
  /** Point observation for lost-ack recovery; no new mutation is authorized by this read. */
  readEvent(missionID: string, eventID: string): Promise<MissionEvent | undefined>
  readDisplay?(missionID: string, pick?: (value: string) => string | undefined, slot?: "tasks" | "pins"):
    Promise<{ value: string; event?: MissionEvent } | undefined>
  saveDisplay?(missionID: string, digest: string, value: string, slot?: "tasks" | "pins"): Promise<void>
}

const DISPLAY_BYTES = 48 * 1024
const displayKey = (range: string, slot?: "tasks" | "pins") => slot ? `display-${slot}:v1:${range}` : `display:v1:${range}`
const displayLimit = (slot?: "tasks" | "pins") => slot ? 96 * 1024 : DISPLAY_BYTES
type Header = { key: string; bytes: number }
type EventHeader = Header & Pick<MissionEvent, "id" | "createdAt">
type Body = { key: string; value: string }
type HeadQualification = { cookie: number; usable: boolean }
type HeadState = { qualification?: HeadQualification; pending?: Promise<HeadQualification | undefined> }
const preparedHeads = new WeakMap<SqlClient.SqlClient, HeadState>()
const stampPattern = /^[0-9A-F]{48}$/
const headPattern = /^([^/]+)\/(\d+)\/(\d+)\/(\d+)$/

function readHeader(row: Record<string, unknown>): Header {
  if (typeof row.key !== "string" || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0)
    throw new Error("Native Mission journal metadata unavailable")
  return { key: row.key, bytes: row.bytes }
}

function parseJSON(value: string): unknown {
  try { return JSON.parse(value) } catch { return undefined }
}

function digestBody(hash: ReturnType<typeof createHash>, key: string, body: string) {
  // Length framing covers the full original JSON, including whitespace and escapes.
  hash.update(`${Buffer.byteLength(key)}:${key}${Buffer.byteLength(body)}:`).update(body)
}

/** Acquire in the current native invocation. No fallback to an unbounded native scan. */
export const acquireNativeJournalRange = Effect.fn("missions.acquireNativeJournalRange")(function* (
  ctx: Pick<Plugin.Context, "location">,
  invocationRun?: NativeMissionDocumentRunner,
) {
  const found = yield* Effect.serviceOption(databaseTag)
  if (Option.isNone(found)) return yield* Effect.fail(new Error("Native Mission journal database unavailable"))
  yield* Schema.decodeUnknownEffect(shape)(found.value)
  const { db } = found.value as NativeDatabase
  const { id: projectID, canonical } = ctx.location.project
  const projectToken = stableToken(`${projectID}\0${canonical}`, 24)
  const projectPrefix = `${ns}${MISSION_JOURNAL_STORAGE_PREFIX}/${projectToken}`
  const projectUpper = projectPrefix.slice(0, -1) + String.fromCharCode(projectPrefix.charCodeAt(projectPrefix.length - 1) + 1)
  const graph = yield* Effect.context<never>()
  const run: NativeMissionDocumentRunner = invocationRun ?? (effect => Effect.runPromise(effect.pipe(Effect.provide(graph))))
  const query = (sql: string, params: readonly unknown[]) => db.$client.unsafe(sql, params).withoutTransform.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(rows)))
  const transaction = <A>(use: () => Effect.Effect<A, unknown>) => run(db.transaction(use, { behavior: "deferred" }))
  const head = journalHeadSQL(`${ns}${MISSION_JOURNAL_STORAGE_PREFIX}/`)
  const state = preparedHeads.get(db.$client) ?? {}
  preparedHeads.set(db.$client, state)
  const schemaCookie = () => query(head.cookie, []).pipe(Effect.map(result => {
    const cookie = result[0]?.schema_version
    return typeof cookie === "number" && Number.isInteger(cookie) ? cookie : undefined
  }), Effect.catch(() => Effect.succeed(undefined)))
  const headAt = (range: string, cookie: number) => Effect.gen(function* () {
    const result = yield* query(head.read, [range, head.epoch, cookie]).pipe(Effect.option)
    const row = Option.isSome(result) ? result.value[0] : undefined
    if (typeof row?.epoch !== "string" || !stampPattern.test(row.epoch)
      || typeof row.stamp !== "string" || (row.stamp !== "" && !stampPattern.test(row.stamp))) return undefined
    const scope = `${stableToken(range, 24)}.${row.epoch}`
    return { token: `${scope}.${row.stamp}`, prior: `${scope}.${row.prior}`, tail: row.tail }
  })
  const ensureHead = () => state.pending ??= Promise.resolve().then(() => run(db.transaction(() => Effect.gen(function* () {
    const existingCookie = yield* schemaCookie()
    if (existingCookie === undefined) return undefined
    const objects = yield* query(`SELECT name,sql FROM main.sqlite_schema WHERE name COLLATE NOCASE IN (?,?,?,?)`, head.names)
    if (objects.length === 0) {
      for (const sql of head.schema) yield* query(sql, [])
    } else if (objects.length !== head.names.length
      || !head.names.every((name, i) => objects.some(row => row.name === name && row.sql === head.schema[i]))) {
      return { cookie: existingCookie, usable: false }
    }
    const cookie = objects.length ? existingCookie : yield* schemaCookie()
    if (cookie === undefined) return yield* Effect.fail(new Error("Native Mission journal schema cookie unavailable"))
    // A different client may already have renewed the incarnation at this cookie.
    if (!(yield* headAt(head.epoch, cookie))) yield* query(head.renew, [head.epoch, cookie])
    return { cookie, usable: true }
  }), { behavior: "immediate" }))).catch(() => undefined).then(qualification => {
    state.qualification = qualification
    state.pending = undefined
    return qualification
  })
  type Head = NonNullable<Effect.Success<ReturnType<typeof headAt>>>
  const observeHead = async <A>(range: string, use: (current: Head | undefined) => Effect.Effect<A, unknown>): Promise<A> => {
    const qualification = state.qualification
    if (qualification) {
      const observed = await transaction(() => Effect.gen(function* () {
        const current = qualification.usable ? yield* headAt(range, qualification.cookie) : undefined
        if (qualification.usable ? !current : (yield* schemaCookie()) !== qualification.cookie) return undefined
        return { value: yield* use(current) }
      }))
      if (observed) return observed.value
    }
    // At most one immediate transaction per read. Failed attempts are retried
    // on later demand, not while holding a range snapshot or spinning on a lock.
    const refreshed = await ensureHead()
    return transaction(() => Effect.gen(function* () {
      return yield* use(refreshed?.usable ? yield* headAt(range, refreshed.cookie) : undefined)
    }))
  }
  const indexedObservation = (token: string, observation: Omit<NativeJournalRangeObservation, "digest">) =>
    ({ ...observation, digest: `${token}/${observation.rows}/${observation.bytes}/${observation.discardedEvents}` })

  function keys(missionID: string) {
    if (!safeKey.test(missionID)) throw new Error("Invalid Mission journal range")
    return { lower: `${projectPrefix}/${missionID}/`, upper: `${projectPrefix}/${missionID}0` }
  }

  function parse(body: Body, prefix: string, missionID: string) {
    const event = parseMissionEvent(parseJSON(body.value))
    return event?.projectID === projectID && event.missionID === missionID && safeKey.test(event.id)
      && body.key === prefix + event.id ? event : undefined
  }

  const readBodies = (headers: readonly Header[]) => Effect.gen(function* () {
    // CROSS JOIN keeps the bounded lookup list outermost and preserves its ordinal.
    const values = yield* query(`SELECT k.key,k.value FROM json_each(?) AS requested
      CROSS JOIN main.kv k ON k.key=requested.value ORDER BY requested.key`, [JSON.stringify(headers.map(row => row.key))])
    if (values.length !== headers.length) throw new Error("Native Mission journal range changed")
    return values.map((row, index): Body => {
      const header = headers[index]
      if (row.key !== header.key || typeof row.value !== "string" || Buffer.byteLength(row.value) !== header.bytes)
        throw new Error("Native Mission journal row unavailable")
      return { key: header.key, value: row.value }
    })
  })

  function* batches<T extends Header>(headers: readonly T[]) {
    for (let begin = 0; begin < headers.length;) {
      let end = begin + 1, bytes = headers[begin].bytes
      // A single larger legacy event is read alone so it remains replayable.
      while (end < headers.length && end - begin < BATCH_ROWS && bytes + headers[end].bytes <= BATCH_BYTES)
        bytes += headers[end++].bytes
      yield headers.slice(begin, end)
      begin = end
    }
  }

  /** One SQLite snapshot; scan by the existing key index. Key order only feeds
   * the digest. Keep scalar ordering records, not bodies, for the replay pass. */
  const traverse = (range: ReturnType<typeof keys>, onBody?: (body: Body, bytes: number) => void, hashBodies = true) =>
    Effect.gen(function* () {
      const hash = hashBodies ? createHash("sha256") : undefined
      // Domain-separate even empty ranges so an observation cannot cross scopes.
      hash?.update(range.lower)
      let after = range.lower, count = 0, bytes = 0
      for (;;) {
        const headers = (yield* query(`SELECT key,length(CAST(value AS BLOB)) AS bytes FROM main.kv
          WHERE key>=? AND key<? AND key>=? ORDER BY key LIMIT ?`, [range.lower, range.upper, after, BATCH_ROWS + 1])).map(readHeader)
        if (!headers.length) break
        const page = headers.slice(0, BATCH_ROWS)
        for (const batch of batches(page)) {
          const values = yield* readBodies(batch)
          for (let i = 0; i < values.length; i++) {
            const body = values[i], size = batch[i].bytes
            if (hash) digestBody(hash, body.key, body.value)
            count++; bytes += size
            onBody?.(body, size)
          }
        }
        if (headers.length <= BATCH_ROWS) break
        after = headers[BATCH_ROWS].key
      }
      return { digest: hash?.digest("base64url"), rows: count, bytes }
    })

  const valueAt = (key: string) => query("SELECT value FROM main.kv WHERE key=?", [key]).pipe(Effect.map(result => {
    const row = result[0]
    if (!row) return undefined
    if (typeof row.value !== "string") throw new Error("Native Mission journal value unavailable")
    return row.value
  }))

  const readOrdered: NativeJournalRange["readOrdered"] = async (missionID, visit, prepare, cachedDigest, advance) => {
    const range = keys(missionID)
    return observeHead(range.lower, current => Effect.gen(function* () {
      const headers: EventHeader[] = []
      const known = cachedDigest && headPattern.exec(cachedDigest)
      if (current && known) {
        const previous = { rows: Number(known[2]), bytes: Number(known[3]), discardedEvents: Number(known[4]) }
        if (current.token === known[1]) return indexedObservation(current.token, previous)
        if (advance && current.prior === known[1] && typeof current.tail === "string" && current.tail.startsWith(range.lower)) {
          const value = yield* valueAt(current.tail)
          if (value !== undefined) {
            const event = parse({ key: current.tail, value }, range.lower, missionID)
            if (event && advance(event)) return indexedObservation(current.token,
              { ...previous, rows: previous.rows + 1, bytes: previous.bytes + Buffer.byteLength(value) })
          }
        }
      }
      const byID = new Map<string, EventHeader>(), reportHeaders = new Map<string, EventHeader>()
      let created: Extract<MissionEvent, { type: "mission.created" }> | undefined
      let discardedEvents = 0
      const { digest, rows, bytes } = yield* traverse(range, (body, bytes) => {
        const event = parse(body, range.lower, missionID)
        if (!event) { discardedEvents++; return }
        const header = { key: body.key, bytes, id: event.id, createdAt: event.createdAt }
        headers.push(header)
        if (prepare) {
          byID.set(event.id, header)
          if (event.type === "mission.created" && (!created || compareEvents(event, created) < 0)) created = event
          if (event.type === "task.reported") {
            const previous = reportHeaders.get(event.report.id)
            if (!previous || compareEvents(event, previous) > 0) reportHeaders.set(event.report.id, header)
          }
        }
      }, !current)
      const observation = current ? indexedObservation(current.token, { rows, bytes, discardedEvents })
        : { digest: digest!, rows, bytes, discardedEvents }
      if (!current && digest === cachedDigest) return observation
      if (prepare && !prepare(observation, created)) return observation
      headers.sort(compareEvents)
      for (const batch of batches(headers)) {
        const values = yield* readBodies(batch)
        const events = values.map(body => {
          const event = parse(body, range.lower, missionID)
          if (!event) throw new Error("Native Mission journal range changed")
          return event
        })
        const related = new Map<string, MissionEvent>(), reports = new Map<string, MissionEvent>()
        if (prepare) {
          const lookups = orderedMissionLookups(events)
          for (const event of events) if (event.type === "mission.deleted") {
            for (const target of event.cleanupTargets ?? []) lookups.events.add(cleanupReceiptID(event.id, target.sessionID))
            if (event.documentCleanup) lookups.events.add(documentCleanupReceiptID(event.id))
          }
          const need = new Set<EventHeader>()
          for (const id of lookups.events) { const header = byID.get(id); if (header) need.add(header) }
          for (const id of lookups.reports) { const header = reportHeaders.get(id); if (header) need.add(header) }
          const available = new Map(events.map(event => [event.id, event]))
          for (const group of batches([...need].filter(header => !available.has(header.id)))) {
            for (const body of yield* readBodies(group)) {
              const event = parse(body, range.lower, missionID)
              if (event) available.set(event.id, event)
            }
          }
          for (const id of lookups.events) { const event = available.get(id); if (event) related.set(id, event) }
          for (const id of lookups.reports) {
            const header = reportHeaders.get(id), event = header && available.get(header.id)
            if (event) reports.set(id, event)
          }
        }
        const result: unknown = visit(events, related, reports)
        if (result !== undefined) {
          if (result instanceof Promise) void Promise.prototype.then.call(result, undefined, () => undefined)
          throw new Error("Mission journal visitor must return void synchronously")
        }
      }
      return observation
    }))
  }

  const adapter: NativeJournalRange = {
    readDisplay: (missionID, pick, slot) => {
      const { lower } = keys(missionID)
      return observeHead(lower, current => Effect.gen(function* () {
        if (!current) return undefined
        const result = yield* query(head.displayRead, [displayKey(lower, slot), current.token, displayLimit(slot)]).pipe(Effect.option)
        const row = Option.isSome(result) ? result.value[0] : undefined
        if (typeof row?.value !== "string" || stableToken(row.value, 64) !== row.checksum) return undefined
        const eventID = pick?.(row.value)
        if (!eventID || !safeKey.test(eventID)) return { value: row.value }
        const key = lower + eventID, value = yield* valueAt(key)
        return { value: row.value, event: value === undefined ? undefined : parse({ key, value }, lower, missionID) }
      }))
    },
    saveDisplay: async (missionID, digest, value, slot) => {
      const token = headPattern.exec(digest)?.[1], qualification = state.qualification
      if (!token || !qualification?.usable || Buffer.byteLength(value) > displayLimit(slot)) return
      const { lower } = keys(missionID)
      await run(db.transaction(() => Effect.gen(function* () {
        const current = yield* headAt(lower, qualification.cookie)
        if (current?.token === token) yield* query(head.displayWrite, [displayKey(lower, slot), stableToken(value, 64), token, value])
      }), { behavior: "immediate" })).catch(() => undefined)
    },
    readOrdered,
    listRanges: () => transaction(() => Effect.gen(function* () {
      const root = projectPrefix + "/", missionIDs = new Set<string>()
      let after = projectPrefix, stray = 0
      for (;;) {
        const page = yield* query("SELECT key FROM main.kv WHERE key>=? AND key<? AND key>=? ORDER BY key LIMIT ?",
          [projectPrefix, projectUpper, after, BATCH_ROWS + 1])
        let skip: string | undefined
        for (const row of page.slice(0, BATCH_ROWS)) {
          if (typeof row.key !== "string") throw new Error("Native Mission journal key unavailable")
          const suffix = row.key.startsWith(root) ? row.key.slice(root.length) : "", end = suffix.indexOf("/")
          const id = end < 0 ? "" : suffix.slice(0, end)
          if (safeKey.test(id)) { missionIDs.add(id); skip = `${root}${id}0`; break }
          else stray++
        }
        if (skip) { after = skip; continue }
        if (page.length <= BATCH_ROWS) break
        const cursor = page[BATCH_ROWS].key
        if (typeof cursor !== "string") throw new Error("Native Mission journal key unavailable")
        after = cursor
      }
      return { missionIDs: [...missionIDs], stray }
    })),
    readEvent: (missionID, eventID) => run(Effect.gen(function* () {
      const { lower } = keys(missionID)
      if (!safeKey.test(eventID)) throw new Error("Invalid Mission journal event key")
      const key = lower + eventID, value = yield* valueAt(key)
      if (value === undefined) return undefined
      const result = parse({ key, value }, lower, missionID)
      if (!result) throw new Error("Native Mission journal event damaged")
      return result
    })),
  }
  return adapter
})
