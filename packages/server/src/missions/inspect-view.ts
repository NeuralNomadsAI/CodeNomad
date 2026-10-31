import { createHash, randomUUID } from "node:crypto"
import type { MissionInspection } from "./control-types"
import type { MissionMap, MissionPlanChange, MissionReport, MissionTask } from "./model"

/** Characters of every `mission.inspect` result as the tool serializes it (two-space
 * indented JSON), its page metadata and omission markers included. A result within it
 * is returned unchanged; a larger one is paged, and every value a page cannot hold
 * names the exact read that returns it. */
export const MISSION_INSPECT_OUTPUT_LIMIT = 100_000

/** Where a value too large for one result lives. Fields are the map's own keys;
 * `revision` pins the map the value was paged from. The native catalog is the
 * caller's Location's, independent of any mission. */
export type MissionInspectSelector =
  | { kind: "inspection"; field: string }
  | { kind: "mission"; field: string }
  | { kind: "task"; taskKey: string; field: string }
  | { kind: "report"; reportId: string; field: string }
  | { kind: "change"; change: number; field: string }
type ContentSource = MissionInspectSelector | { kind: "catalog" }
/** A content read. `digest` names the exact serialized value its slices are cut from:
 * values read afresh on each call (the catalog, native conversations, human answers)
 * can change without a new revision, so a slice of a value that now reads differently
 * is refused and slices never join two observations. A `receipt` read names, by its
 * digest alone, the whole original result of a `mission.interrupt` call too large for
 * one result, as the plugin holds it. Catalog and receipt reads name no mission. */
export type MissionInspectContent = ((MissionInspectSelector & { revision: number }) | { kind: "catalog" } | { kind: "receipt" })
  & { digest: string; offset: number }
const CATALOG = { kind: "catalog" } as const

/** Task fields of the `taskKey` view computed outside the map; the plugin supplies them. */
export const MISSION_TASK_VIEW_FIELDS = ["contract", "assignmentPrompt", "requirement", "native", "humanAnswers"] as const

const PAGE_NOTE = `This map is larger than one ${MISSION_INSPECT_OUTPUT_LIMIT}-character result: its tasks are paged in map order, each with its own reports`
  + " (report, lateReports). Continue with mission.inspect({ missionID, taskOffset: nextTaskOffset }). A value replaced by"
  + " { omittedCharacters, read } is returned by mission.inspect(read)."
const LIST_NOTE = "These missions are paged, newest first: continue with mission.inspect({ list: true, listOffset: nextListOffset })."
  + " A value replaced by { omittedCharacters, read } is returned by mission.inspect(read)."
const CONTENT_NOTE = "One slice of a value too large for one result: join text from offset 0 while next is present."
  + " With json, the joined text is the value's JSON; otherwise it is the string itself."
const VIEW_NOTE = "A value replaced by { omittedCharacters, read } is returned by mission.inspect(read)."

type Owner = Record<string, unknown>
/** A replaceable value: `tier` 1 holds lists whose items have their own tier-0 slots. */
interface Slot { owner: Owner; key: string; selector: ContentSource; tier: 0 | 1 }

/** The model-facing `mission.inspect` map value. A map within the limit is the full
 * inspection. Without `taskOffset`, a larger one is its header (the inspection and the map
 * without tasks and reports, its largest values replaced until the whole page fits)
 * with the whole tasks that still fit. With `taskOffset`, the map's identity and whole
 * tasks from that position; a task too large alone has its largest values replaced, so
 * every explicit page progresses. Tasks carry their reports; `mission.reports`, which
 * repeats them, is left out of pages. Without a mission, a catalog too large for the
 * result is replaced by its read. */
export function boundedInspection(inspection: MissionInspection, taskOffset?: number): unknown {
  const mission = inspection.mission
  if (size(inspection) <= MISSION_INSPECT_OUTPUT_LIMIT) return inspection
  if (!mission) {
    const value: Owner = { ...inspection }, result = () => ({ ...value, note: VIEW_NOTE })
    if (!fit(result, value.catalog === undefined ? [] : [{ owner: value, key: "catalog", selector: CATALOG, tier: 0 }])) throw outOfBounds()
    return checked(result())
  }
  const total = mission.tasks.length, offset = Math.min(taskOffset ?? 0, total)
  const outer: Owner = {}, header: Owner = { id: mission.id, revision: mission.revision }, slots: Slot[] = []
  if (taskOffset === undefined) {
    const { mission: _mission, ...rest } = inspection
    for (const [field, value] of Object.entries(rest)) {
      outer[field] = value
      slots.push({ owner: outer, key: field, selector: field === "catalog" ? CATALOG : { kind: "inspection", field }, tier: 0 })
    }
    const { tasks: _tasks, reports: _reports, ...fields } = mission
    for (const [field, value] of Object.entries(fields)) {
      header[field] = value
      if (field !== "id" && field !== "revision") slots.push({ owner: header, key: field, selector: { kind: "mission", field }, tier: 0 })
    }
  }
  const page = (tasks: readonly unknown[], next: number) => ({
    ...outer, mission: { ...header, tasks },
    taskPage: { offset, returned: tasks.length, total, ...(next < total ? { nextTaskOffset: next } : {}), note: PAGE_NOTE },
  })
  // The header is fitted inside the whole envelope, with the widest next offset.
  if (!fit(() => page([], Math.max(0, total - 1)), slots, mission)) throw outOfBounds()
  const tasks: unknown[] = []
  let used = size(page([], Math.max(0, total - 1)))
  for (let index = offset; index < total; index++) {
    const view = pagedTask(mission.tasks[index])
    used += nestedSize(view)
    if (used > MISSION_INSPECT_OUTPUT_LIMIT) break
    tasks.push(view)
  }
  while (tasks.length && size(page(tasks, offset + tasks.length)) > MISSION_INSPECT_OUTPUT_LIMIT) tasks.pop()
  if (!tasks.length && taskOffset !== undefined && offset < total) {
    const view = pagedTask(mission.tasks[offset])
    if (!fit(() => page([view], offset + 1), taskSlots(view, mission.tasks[offset].key), mission)) throw outOfBounds()
    tasks.push(view)
  }
  return checked(page(tasks, offset + tasks.length))
}

/** The `taskKey` view (`missionID`, `revision`, the compact task and its native context)
 * with every report of that task, each once, its largest values replaced until it fits. */
export function boundedTaskView(view: Owner, mission: MissionMap, taskKey: string): unknown {
  const value: Owner = { ...view }, slots: Slot[] = []
  for (const field of Object.keys(value)) {
    if (["missionID", "revision", "status", "runState", "task"].includes(field)) continue
    if (field === "reports") continue
    slots.push({ owner: value, key: field, tier: 0, selector: field === "frontier" ? { kind: "mission", field }
      : field === "catalog" ? CATALOG : { kind: "task", taskKey, field } })
  }
  if (Array.isArray(value.reports)) {
    const reports = value.reports = (value.reports as MissionReport[]).map(report => ({ ...report }))
    for (const report of reports) slots.push(...reportSlots(report))
    slots.push({ owner: value, key: "reports", selector: { kind: "task", taskKey, field: "reports" }, tier: 1 })
  }
  const result = () => ({ ...value, note: VIEW_NOTE })
  if (size(view) <= MISSION_INSPECT_OUTPUT_LIMIT) return view
  if (!fit(result, slots, mission)) throw outOfBounds()
  return checked(result())
}

/** `mission.inspect({ list: true })`, paged newest first when the whole list exceeds the limit. */
export function boundedMissionList(missions: ReadonlyArray<Owner & { missionID: string; revision: number }>, listOffset?: number): unknown {
  if (listOffset === undefined && size({ missions }) <= MISSION_INSPECT_OUTPUT_LIMIT) return { missions }
  const total = missions.length, offset = Math.min(listOffset ?? 0, total)
  const page = (entries: readonly unknown[], next: number) => ({ missions: entries,
    listPage: { offset, returned: entries.length, total, ...(next < total ? { nextListOffset: next } : {}), note: LIST_NOTE } })
  const entries: unknown[] = []
  let used = size(page([], Math.max(0, total - 1)))
  for (let index = offset; index < total; index++) {
    used += nestedSize(missions[index], 2)
    if (used > MISSION_INSPECT_OUTPUT_LIMIT) break
    entries.push(missions[index])
  }
  while (entries.length && size(page(entries, offset + entries.length)) > MISSION_INSPECT_OUTPUT_LIMIT) entries.pop()
  if (!entries.length && offset < total) {
    const entry: Owner = { ...missions[offset] }
    const slots = Object.keys(entry).filter(field => !["missionID", "revision", "relation", "status"].includes(field))
      .map(field => ({ owner: entry, key: field, selector: { kind: "mission" as const, field }, tier: 0 as const }))
    if (!fit(() => page([entry], offset + 1), slots, { id: missions[offset].missionID, revision: missions[offset].revision })) throw outOfBounds()
    entries.push(entry)
  }
  return checked(page(entries, offset + entries.length))
}

/** The value a content read names, from the full inspection: map fields, a task's own
 * fields (and `reports`, its reports each once), any report by ID, a plan change.
 * `MISSION_TASK_VIEW_FIELDS` and the catalog are the plugin's. */
export function inspectionContentValue(inspection: MissionInspection, read: MissionInspectContent): unknown {
  const mission = inspection.mission
  if (!mission || read.kind === "catalog" || read.kind === "receipt") throw contentUnavailable()
  if (read.revision !== mission.revision) throw new Error("Mission changed since this page: read it again from its first page")
  if (read.kind !== "inspection") return missionContentValue(mission, read)
  if (read.field === "mission" || !Object.prototype.hasOwnProperty.call(inspection, read.field)) throw contentUnavailable()
  return (inspection as unknown as Owner)[read.field]
}

/** The value a map selector names in `mission`: a map field, a task's own field (and
 * `reports`, its reports each once), any report by ID (current, earlier or late), a
 * plan change by revision among `changes` (the map's `history` unless given). Throws
 * `Mission content unavailable` when it names none. */
export function missionContentValue(mission: MissionMap, read: Exclude<MissionInspectSelector, { kind: "inspection" }>,
  changes: readonly MissionPlanChange[] = mission.history): unknown {
  const field = (owner: object | undefined) => {
    if (!owner || !Object.prototype.hasOwnProperty.call(owner, read.field)) throw contentUnavailable()
    return (owner as Owner)[read.field]
  }
  if (read.kind === "mission") return field(mission)
  if (read.kind === "report") return field(mission.reports.find(report => report.id === read.reportId))
  if (read.kind === "change") return field(changes.find(change => change.revision === read.change))
  const task = mission.tasks.find(task => task.key === read.taskKey)
  return field(task && { ...pagedTask(task), reports: mission.reports.filter(report => report.taskKey === task.key) })
}

/** One slice of a value: the string itself, or the value's JSON, from `read.offset`,
 * as long as the whole result fits; `next` repeats the read from where it stopped.
 * `value` is read afresh and must be the one `read.digest` names. `missionID` is the
 * mission of map reads; catalog and receipt reads name none. */
export function inspectionContent(missionID: string | undefined, read: MissionInspectContent, value: unknown): unknown {
  const json = typeof value !== "string", text = contentText(value)
  if (contentDigest(text) !== read.digest) throw new Error("This value changed since its first slice: inspect again for its current read")
  if (read.offset > text.length) throw new Error("Mission content offset is past its end")
  const missionless = read.kind === "catalog" || read.kind === "receipt"
  if (!missionless && !missionID) throw contentUnavailable()
  const owner = missionless ? {} : { missionID }
  const result = (end: number) => ({ ...(read.kind === "catalog" || read.kind === "receipt" ? {} : { mission: { id: missionID, revision: read.revision } }),
    content: { ...read, characters: text.length, ...(json ? { json: true } : {}), text: text.slice(read.offset, end),
      ...(end < text.length ? { next: { ...owner, content: { ...read, offset: end } } } : {}) }, note: CONTENT_NOTE })
  return checked(result(sliceEnd(text, read.offset, result)))
}

/** Where the longest slice of `text` from `offset` ends such that `envelope(end)`, as
 * two-space JSON, stays within `MISSION_INSPECT_OUTPUT_LIMIT`; a slice never splits a
 * surrogate pair, and at least one character (or the empty remainder) always fits. */
export function sliceEnd(text: string, offset: number, envelope: (end: number) => unknown): number {
  const fits = (end: number) => size(envelope(end)) <= MISSION_INSPECT_OUTPUT_LIMIT
  let low = Math.min(text.length, offset + (isHighSurrogate(text, offset) ? 2 : 1)), high = text.length
  if (!fits(low)) throw outOfBounds()
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  return isHighSurrogate(text, low - 1) && low > offset + 1 ? low - 1 : low
}

/** Whether `value`, as two-space JSON, stays within `MISSION_INSPECT_OUTPUT_LIMIT`. */
export function withinInspectBound(value: unknown): boolean {
  return size(value) <= MISSION_INSPECT_OUTPUT_LIMIT
}

/** A result within `MISSION_INSPECT_OUTPUT_LIMIT`, the named values of `value` replaced,
 * largest first, by `{ omittedCharacters, read }` naming their exact `mission.inspect`
 * read of `mission`'s revision until it fits. Throws when it cannot. */
export function boundedResult<T extends Owner>(value: T, mission: Pick<MissionMap, "id" | "revision">,
  replaceable: ReadonlyArray<{ key: keyof T & string; selector: MissionInspectSelector }>): T {
  if (size(value) <= MISSION_INSPECT_OUTPUT_LIMIT) return value
  const result: Owner = { ...value }
  if (!fit(() => result, replaceable.map(({ key, selector }) => ({ owner: result, key, selector, tier: 0 as const })), mission)) throw outOfBounds()
  return checked(result) as T
}

/** A task as pages show it: its own values, each report in it once. */
function pagedTask(task: MissionTask): Owner {
  return { ...task, ...(task.report ? { report: { ...task.report } } : {}),
    ...(task.lateReports ? { lateReports: task.lateReports.map(report => ({ ...report })) } : {}) }
}

function taskSlots(view: Owner, taskKey: string): Slot[] {
  const slots: Slot[] = []
  for (const field of Object.keys(view)) {
    if (field === "key" || field === "id") continue
    if (field === "report") { slots.push(...reportSlots(view.report as Owner)); continue }
    if (field === "lateReports") for (const report of view.lateReports as Owner[]) slots.push(...reportSlots(report))
    slots.push({ owner: view, key: field, selector: { kind: "task", taskKey, field }, tier: field === "lateReports" ? 1 : 0 })
  }
  return slots
}

/** A report keeps its identity and outcome in place; its other values are replaceable. */
function reportSlots(report: Owner): Slot[] {
  return Object.keys(report).filter(field => !["id", "taskKey", "outcome", "createdAt", "late"].includes(field))
    .map(field => ({ owner: report, key: field, selector: { kind: "report", reportId: report.id as string, field }, tier: 0 }))
}

/** Replaces slot values, largest serialized first and tier 0 before tier 1, by their
 * omission markers until `envelope` fits. False when nothing more can be replaced.
 * `mission` pins the map selectors; only catalog slots go without one. A marker names
 * its value as read, before any value nested in it gave way. The envelope is serialized
 * once: a replacement changes its exact size by the difference of the two values' texts
 * at the value's indentation, so fitting stays linear in the envelope. */
function fit(envelope: () => unknown, slots: Slot[], mission?: Pick<MissionMap, "id" | "revision">): boolean {
  const open = slots.filter(slot => slot.owner[slot.key] !== undefined).map(slot => ({ ...slot, text: contentText(slot.owner[slot.key]) }))
  let total = size(envelope())
  for (const tier of [0, 1] as const) {
    if (total <= MISSION_INSPECT_OUTPUT_LIMIT) return true
    const members = open.filter(slot => slot.tier === tier), indents = indentations(envelope, members)
    // Values of one tier are disjoint, so their texts hold until they are replaced;
    // a tier-1 list is measured once its items' values have given way.
    const ranked = members.map((slot, index) => ({ slot, indent: indents[index], ...printed(slot.owner[slot.key]) }))
      .sort((left, right) => right.size - left.size)
    for (const { slot, indent, size: current, breaks } of ranked) {
      if (total <= MISSION_INSPECT_OUTPUT_LIMIT) return true
      const marker = omission(mission, slot.selector, slot.text), replacement = printed(marker)
      if (replacement.size >= current) continue
      slot.owner[slot.key] = marker
      total += replacement.size - current + indent * (replacement.breaks - breaks)
    }
  }
  return total <= MISSION_INSPECT_OUTPUT_LIMIT
}

/** A value's two-space JSON alone: its length and line breaks. Nested at indentation
 * `n`, every line after the first gains `n` spaces. */
function printed(value: unknown): { size: number; breaks: number } {
  const text = JSON.stringify(value, null, 2)
  let breaks = 0
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) breaks++
  return { size: text.length, breaks }
}

/** The indentation of each slot's value in the envelope: one serialization with every
 * slot's value standing in as a unique token (values restored after it). */
function indentations(envelope: () => unknown, slots: readonly Slot[]): number[] {
  const nonce = randomUUID(), saved = slots.map(slot => slot.owner[slot.key])
  let text: string
  slots.forEach((slot, index) => { slot.owner[slot.key] = `${nonce}:${index}` })
  try { text = JSON.stringify(envelope(), null, 2) } finally { slots.forEach((slot, index) => { slot.owner[slot.key] = saved[index] }) }
  return slots.map((_, index) => {
    const at = text.indexOf(`"${nonce}:${index}"`)
    if (at < 0) throw new Error("Mission inspection value is outside its result")
    const line = text.lastIndexOf("\n", at) + 1
    let indent = 0
    while (text.charCodeAt(line + indent) === 32) indent++
    return indent
  })
}

function omission(mission: Pick<MissionMap, "id" | "revision"> | undefined, selector: ContentSource, text: string) {
  const digest = contentDigest(text)
  if (selector.kind === "catalog") return { omittedCharacters: text.length, read: { content: { ...selector, digest, offset: 0 } } }
  if (!mission) throw contentUnavailable()
  return { omittedCharacters: text.length, read: { missionID: mission.id, content: { ...selector, revision: mission.revision, digest, offset: 0 } } }
}

/** The text a content read slices: the string itself, or the value's JSON. */
export function contentText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "null"
}

/** SHA-256 of the text's UTF-16 code units, so strings differing only in unpaired
 * surrogates (which UTF-8 encodes alike) keep distinct digests. */
export function contentDigest(text: string): string {
  return createHash("sha256").update(text, "utf16le").digest("base64url")
}

function isHighSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return code >= 0xd800 && code <= 0xdbff
}

function checked<T>(value: T): T {
  if (size(value) > MISSION_INSPECT_OUTPUT_LIMIT) throw outOfBounds()
  return value
}

function outOfBounds(): Error {
  return new Error(`Mission inspection cannot fit ${MISSION_INSPECT_OUTPUT_LIMIT} characters`)
}

function contentUnavailable(): Error {
  return new Error("Mission content unavailable")
}

function size(value: unknown): number {
  return JSON.stringify(value, null, 2).length
}

/** Serialized size of an array item `depth` levels deep (tasks are three), its separator included. */
function nestedSize(value: unknown, depth = 3): number {
  const text = JSON.stringify(value, null, 2)
  return text.length + 2 * depth * (text.split("\n").length) + 2
}
