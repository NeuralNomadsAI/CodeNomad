import { createSignal, untrack } from "solid-js"
import type { MissionListResponse, MissionPanelMap, MissionSummary, MissionActivityProjection } from "../../../server/src/api-types"
import type { MissionUnavailableReason } from "../../../server/src/missions/model"
import type { MissionPanelPageRequest, MissionPanelPage } from "../../../server/src/missions/mission-panel-wire"
import type { MissionTaskFetch } from "./mission-store"
import { createMissionStore, type MissionDisplayResponse } from "./mission-store"
import { MissionTaskPageReadError, MissionPanelMissingError, taskPageDigest, type MissionPanelReadScope } from "../lib/mission-task-page-read"
import { assertTaskReadLive, raceTaskRead, TASK_READ_TIMEOUT_MS } from "../lib/mission-task-read-lifetime"
import { panelSummarySchema, panelCleanupSchema, panelHeaderSchema, panelObservationSchema, panelMarksSchema, panelPersistedActorSchema, panelHistorySchema, panelReportSchema, type PanelHeader, type PanelObservation } from "../lib/mission-panel-schema"
import { recordMissionRowRevision, recordMissionTaskSource } from "./mission-task-pages"
import { seedMissionFinishedSeen } from "./mission-view-state"

type Selector = Exclude<MissionPanelPageRequest, { source: "tasks" }>
type Answer = { envelope: MissionPanelPage; values: unknown[] }
type Window = NonNullable<MissionPanelPage["window"]>
export interface MissionPanelProgress { loading: boolean; loaded: number; total?: number; more: boolean; failure?: "changed" | "failed" }
interface Page { values: unknown[]; window: Window; revision?: number; observedAt?: number; serial: number; epoch: number; cycle: number }
interface Lane { pages: Map<number, Page>; loading: boolean; cycle: number; failed?: { selector: Selector; changed: boolean }; pending?: Promise<void>
  field?: Pick<Extract<Selector, { source: "mission" }>, "missionID" | "field" | "part" | "text">
  pendingSelector?: string; pendingCurrent?: () => boolean; failures: Map<string, { selector: Selector; changed: boolean }>
  inventoryRows?: Map<string, { value: unknown; revision: number; serial: number; epoch: number }> }
interface Entry {
  controller: AbortController; epoch: number; owners: Map<string, { id: string; reader: boolean }>; panel: boolean
  maps: Map<string, { header: PanelHeader; map: MissionPanelMap; epoch: number }>; lanes: Map<string, Lane>; projectID?: string; baseline?: number; seeded?: boolean
  missionOwners: Map<string, AbortController>
  refreshDeadline?: number
  headerReads: Map<string, { owner: AbortController; promise: Promise<void>; trailing: boolean }>
  headerErrors: Map<string, { revision: number; reason: "changed" | "failed"; unavailableReason?: MissionUnavailableReason }>; missing: Set<string>
  originCurrent?: () => boolean
}
export function createMissionPanelInventory(input: {
  read(instanceId: string, selector: Selector, scope: MissionPanelReadScope): Promise<Answer>
  tasks: MissionTaskFetch
  scope(instanceId: string): string
  projectID?(instanceId: string): string | undefined
  capture?(instanceId: string): () => boolean
}) {
  const entries = new Map<string, Entry>(), [version, setVersion] = createSignal(0)
  const observationOwner = new WeakMap<object, { epoch: number; cycle: number; lane: string; offset: number }>()
  let readSerial = 0
  const changed = () => setVersion(value => value + 1)
  const entry = (id: string): Entry => {
    let own = entries.get(id)
    if (!own) entries.set(id, own = { controller: new AbortController(), epoch: 0, owners: new Map(), panel: false, maps: new Map(), lanes: new Map(), missionOwners: new Map(), headerReads: new Map(), headerErrors: new Map(), missing: new Set() })
    const project = input.projectID?.(id), differentProject = Boolean(own.projectID && project && own.projectID !== project)
    if (differentProject || own.originCurrent && !own.originCurrent()) {
      own.controller.abort(); own.epoch++; own.controller = new AbortController(); own.headerErrors.clear(); own.missing.clear(); own.headerReads.clear()
      if (differentProject) { own.projectID = undefined; own.baseline = undefined; own.seeded = false; own.maps.clear(); own.lanes.clear() }
      base.invalidateTasks(id); changed()
    }
    own.originCurrent = input.capture?.(id) ?? (() => true)
    if (own.controller.signal.aborted) own.controller = new AbortController()
    return own
  }
  const lane = (own: Entry, key: string) => {
    let value = own.lanes.get(key)
    if (!value) own.lanes.set(key, value = { pages: new Map(), loading: false, cycle: 0, failures: new Map() })
    return value
  }
  const values = (own: Entry, key: string) => {
    const target = own.lanes.get(key), pages = [...(target?.pages.entries() ?? [])].sort(([a], [b]) => a - b)
    const first = pages.find(([offset]) => offset === 0)?.[1]
    if (target?.inventoryRows) {
      const idOf = (value: unknown) => key === "summaries" ? (value as { id: string }).id : JSON.stringify([(value as { missionID: string }).missionID, (value as { deletionID: string }).deletionID])
      const order = new Set(pages.filter(([, page]) => page.window.order === first?.window.order).flatMap(([, page]) => page.values.map(idOf)))
      for (const id of target.inventoryRows.keys()) order.add(id)
      const rows = [...order].flatMap(id => target.inventoryRows!.has(id) ? [target.inventoryRows!.get(id)!.value] : [])
      return key === "cleanups" ? rows.sort((a, b) => {
        const left = a as { pending: number; documentPending?: boolean; createdAt: number; deletionID: string }, right = b as typeof left
        return Number(right.pending > 0 || right.documentPending === true) - Number(left.pending > 0 || left.documentPending === true) || right.createdAt - left.createdAt || left.deletionID.localeCompare(right.deletionID)
      }) : rows
    }
    let end = 0
    if (first) for (const [, page] of pages) {
      if (page.window.order !== first.window.order || page.window.offset !== end) break
      end = page.window.end
    }
    return pages.filter(([, page]) => !first || end < first.window.total || page.window.order === first.window.order && page.window.offset <= end).flatMap(([, page]) => page.values)
  }
  const progress = (instanceId: string, key: string): MissionPanelProgress => {
    version()
    const own = entries.get(instanceId), value = own?.lanes.get(key), first = value?.pages.get(0)
    let loaded = 0
    if (first) for (const page of [...value!.pages.values()].sort((a, b) => a.window.offset - b.window.offset)) {
      if (page.window.order !== first.window.order || page.window.offset !== loaded || page.epoch !== own!.epoch
        || (key === "marks" || key.startsWith("activity:")) && page.cycle !== value!.cycle) break
      loaded = page.window.end
    }
    return { loading: value?.loading ?? false, loaded, total: first?.window.total, more: first !== undefined && loaded < first.window.total,
      ...(value?.failed ? { failure: value.failed.changed ? "changed" as const : "failed" as const } : {}) }
  }
  const scope = (instanceId: string, own: Entry, missionID?: string, expires = performance.now() + TASK_READ_TIMEOUT_MS): MissionPanelReadScope => {
    const controller = own.controller, epoch = own.epoch, deadline = expires, origin = own.originCurrent ?? (() => true)
    let owner: AbortController | undefined
    if (missionID) {
      owner = own.missionOwners.get(missionID)
      if (!owner) own.missionOwners.set(missionID, owner = new AbortController())
    }
    return { projectID: own.projectID, deadline,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(0, Math.ceil(deadline - performance.now()))), ...(owner ? [owner.signal] : [])]),
      current: () => origin() && entries.get(instanceId) === own && own.epoch === epoch && own.controller === controller && !controller.signal.aborted
        && (!missionID || own.missionOwners.get(missionID) === owner && [...own.owners.values()].some(item => item.id === missionID)),
      onFinishHighWater: (projectID, value) => {
        if (own.projectID && projectID !== own.projectID) throw new MissionTaskPageReadError("invalid")
        own.projectID = projectID
        if (own.baseline === undefined) own.baseline = value
      } }
  }
  const adopt = (own: Entry, answer: Answer) => {
    if (own.projectID && own.projectID !== answer.envelope.projectID) throw new MissionTaskPageReadError("invalid")
    own.projectID = answer.envelope.projectID
  }
  const observations = (instanceId: string, missionID: string): PanelObservation[] => {
    version()
    const own = entries.get(instanceId)
    return own ? (values(own, `activity:${missionID}`) as PanelObservation[]).map(page => currentObservation(own, page) ? page
      : { ...page, coverage: "unknown", requests: { ...page.requests, state: "unknown" } }) : []
  }
  const currentObservation = (own: Entry, page: PanelObservation) => {
    const stamp = observationOwner.get(page)
    const lane = stamp && own.lanes.get(stamp.lane)
    return stamp?.epoch === own.epoch && stamp.cycle === lane?.cycle
      && ![...lane.failures.values()].some(failure => failure.changed || offsetOf(failure.selector) === stamp.offset)
  }
  const offsetOf = (selector: Selector) => selector.source === "activity" ? selector.actorOffset ?? 0 : selector.source === "marks" ? selector.missionOffset ?? 0 : selector.window?.offset ?? 0
  const orderOf = (selector: Selector) => selector.source === "activity" ? selector.actorOrder : selector.source === "marks" ? selector.missionOrder : selector.window?.order
  const activity = (own: Entry): MissionActivityProjection => {
    const marks = values(own, "marks") as PanelObservation[], selected = [...own.lanes.keys()].filter(key => key.startsWith("activity:")).flatMap(key => values(own, key) as PanelObservation[])
    const byMission = new Map<string, PanelObservation[]>()
    for (const observed of [...marks, ...selected]) {
      const list = byMission.get(observed.context.id) ?? []
      if (selected.includes(observed) && list.every(item => !selected.includes(item))) list.length = 0
      list.push(observed); byMission.set(observed.context.id, list)
    }
    const generatedAt = Math.max(0, ...[...own.lanes].filter(([key]) => key === "marks" || key.startsWith("activity:")).flatMap(([, lane]) => [...lane.pages.values()].map(page => page.observedAt ?? 0)))
    const revisions = new Map((values(own, "summaries") as Array<{ id: string; revision: number }>).map(row => [row.id, row.revision]))
    return { generatedAt, missions: [...byMission].map(([missionId, pages]) => {
      const actors = new Map(pages.flatMap(page => page.activity.actors.map(actor => currentObservation(own, page) ? actor : { ...actor, state: "unknown" as const })).map(actor => [actor.sessionId, actor]))
      const complete = pages.length === 1 && currentObservation(own, pages[0]) && pages[0].coverage === "observed" && pages[0].activity.family.state === "observed"
        && pages[0].context.revision >= (own.maps.get(missionId)?.map.revision ?? revisions.get(missionId) ?? 0)
      // Separately observed windows never manufacture a whole-mission idle proof.
      return { missionId, actors: [...actors.values()].map(actor => !complete && actor.state === "idle-without-report" ? { ...actor, state: "unknown" as const } : actor),
        family: { state: complete ? "observed" as const : "partial" as const, members: [...new Map(pages.filter(page => currentObservation(own, page) && page.activity.family.state !== "unknown").flatMap(page => page.activity.family.members)
          .filter(member => member.kind !== undefined).map(member => [member.sessionId, { ...member, kind: member.kind! }])).values()] } }
    }) }
  }
  async function readLane(instanceId: string, key: string, selector: Selector, parent?: MissionPanelReadScope, restart = false): Promise<void> {
    const own = entry(instanceId), target = lane(own, key)
    if (selector.source === "mission") target.field = { missionID: selector.missionID, field: selector.field, part: selector.part, text: selector.text }
    const superseded = restart ? new Map(target.failures) : undefined
    const signature = JSON.stringify([selector.source, "missionID" in selector ? selector.missionID : null, selector.source === "mission" ? [selector.field, selector.part, selector.text] : null, offsetOf(selector), orderOf(selector)]), waiting = target.pending
    if (!restart && waiting && target.pendingSelector === signature && target.pendingCurrent?.()) return waiting
    const serial = ++readSerial
    const ownLife = scope(instanceId, own, selector.source === "mission" || selector.source === "activity" ? selector.missionID : undefined)
    const life = parent ? { ...ownLife, deadline: Math.min(ownLife.deadline!, parent.deadline!), signal: AbortSignal.any([ownLife.signal!, parent.signal!]), current: () => ownLife.current() && parent.current() } : ownLife
    const failed = (error: unknown) => {
      if (life.current()) {
        target.failures.set(signature, { selector, changed: error instanceof MissionTaskPageReadError && error.reason === "changed" })
        target.failed = target.failures.values().next().value
      }
    }
    let operation: Promise<void>
    const run = async () => {
      const advancing = selector.source === "activity" && !selector.actorOffset || selector.source === "marks" && !selector.missionOffset
      const cycle = target.cycle + Number(advancing)
      try {
        if (!life.current()) throw new DOMException("Obsolete window owner", "AbortError")
        assertTaskReadLive(life.signal, life.deadline)
        target.loading = true; changed()
        const answer = await raceTaskRead(input.read(instanceId, selector, life), life.signal)
        if (!life.current()) return
        assertTaskReadLive(life.signal, life.deadline); adopt(own, answer)
        let rows: unknown[], window: Window
        if (selector.source === "summaries" || selector.source === "cleanups") {
          rows = answer.values.map(value => (selector.source === "summaries" ? panelSummarySchema : panelCleanupSchema).parse(value))
          const ids = rows.map(value => selector.source === "summaries" ? (value as { id: string }).id : JSON.stringify([(value as { missionID: string }).missionID, (value as { deletionID: string }).deletionID]))
          if (new Set(ids).size !== ids.length || !answer.envelope.window) throw new MissionTaskPageReadError("invalid")
          window = answer.envelope.window
        } else if (selector.source === "marks") {
          if (answer.values.length !== 1) throw new MissionTaskPageReadError("invalid")
          const observed = panelMarksSchema.parse(answer.values[0]); rows = observed.observations; window = observed.missionPage
          if (window.offset !== Math.min(selector.missionOffset ?? 0, window.total) || window.end !== Math.min(window.offset + 16, window.total)
            || selector.missionOrder && window.order !== selector.missionOrder || observed.observations.some(page => page.context.actorPage.offset !== 0 || page.context.actorPage.end !== Math.min(10, page.context.actorPage.total))) throw new MissionTaskPageReadError("invalid")
          if (observed.observations.some(page => page.context.projectID !== own.projectID)) throw new MissionTaskPageReadError("invalid")
        } else if (selector.source === "activity") {
          if (answer.values.length !== 1) throw new MissionTaskPageReadError("invalid")
          const observed = panelObservationSchema.parse(answer.values[0]); rows = [observed]; window = observed.context.actorPage
          const shown = own.maps.get(selector.missionID)?.header
          if (observed.context.id !== selector.missionID || observed.context.revision !== answer.envelope.revision
            || observed.context.projectID !== own.projectID || window.offset !== Math.min(selector.actorOffset ?? 0, window.total)
            || window.end !== Math.min(window.offset + 160, window.total) || selector.actorOrder && window.order !== selector.actorOrder
            || ["discardedEvents", "controlUnavailable", "notificationUnavailable", "cleanupUnavailable"].some(key => observed.context[key as keyof typeof observed.context] !== answer.envelope[key as keyof MissionPanelPage])
            || shown && (observed.context.coordinatorSessionId !== shown.root.coordinatorSessionId || observed.context.revision === shown.root.revision
              && (window.total !== shown.collections.actors.total || shown.collections.actors.order !== undefined && window.order !== shown.collections.actors.order
                || observed.context.status !== shown.root.status || observed.context.runState !== shown.root.runState))) throw new MissionTaskPageReadError("invalid")
        } else {
          if (!answer.envelope.window) throw new MissionTaskPageReadError("invalid")
          rows = answer.values.map(value => selector.text ? typeof value === "string" && value.length <= 32769 ? value : (() => { throw new MissionTaskPageReadError("invalid") })()
            : selector.field === "actors" ? panelPersistedActorSchema.parse(value)
            : selector.field === "reports" ? panelReportSchema.parse(value) : selector.field === "history" ? panelHistorySchema.parse(value) : value)
          recordMissionRowRevision(rows.filter((value): value is object => value !== null && typeof value === "object"), answer.envelope.revision!)
          window = answer.envelope.window
          const header = own.maps.get(selector.missionID)?.header, descriptor = !selector.part && selector.field && header?.collections[selector.field]
          if (!selector.text && selector.part && header?.control && header.root.revision === answer.envelope.revision && window.total !== header.control[selector.part]) throw new MissionTaskPageReadError("invalid")
          if (descriptor && header!.root.revision === answer.envelope.revision) {
            if (selector.text ? window.total !== Math.ceil(descriptor.characters / 32768) || window.order !== descriptor.digest
              : window.total !== descriptor.total || descriptor.array && window.order !== descriptor.digest) throw new MissionTaskPageReadError("invalid")
            if (window.offset === 0 && window.end === window.total) {
              const text = selector.text ? answer.values[0] as string : JSON.stringify(descriptor.array ? answer.values : answer.values[0])
              if (text.length !== descriptor.characters || await taskPageDigest(text, life.signal, life.deadline) !== descriptor.digest) throw new MissionTaskPageReadError("invalid")
            }
          }
        }
        const rowIdentity = selector.source === "summaries" ? (value: unknown) => (value as { id: string }).id
          : selector.source === "cleanups" ? (value: unknown) => JSON.stringify([(value as { missionID: string }).missionID, (value as { deletionID: string }).deletionID])
          : selector.source === "mission" && !selector.text && selector.field === "actors" ? (value: unknown) => (value as { sessionId: string }).sessionId
          : selector.source === "mission" && !selector.text && selector.field === "reports" ? (value: unknown) => (value as { id: string }).id
          : selector.source === "mission" && !selector.text && selector.field === "history" ? (value: unknown) => String((value as { revision: number }).revision) : undefined
        if (rowIdentity) {
          const ids = new Set(rows.map(rowIdentity))
          if (ids.size !== rows.length || [...target.pages.values()].some(page => page.epoch === own.epoch && page.window.order === window.order
            && page.window.offset !== window.offset && page.values.some(value => ids.has(rowIdentity(value))))) throw new MissionTaskPageReadError("invalid")
        }
        assertTaskReadLive(life.signal, life.deadline)
        if (!life.current()) return
        if (selector.source === "summaries" && own.baseline !== undefined) {
          seedMissionFinishedSeen(JSON.stringify([input.scope(instanceId), own.projectID]), own.baseline, input.scope(instanceId), rows as MissionSummary[])
          own.seeded = true
        }
        if (selector.source === "marks" || selector.source === "activity") for (const row of rows) observationOwner.set(row as object, { epoch: own.epoch, cycle, lane: key, offset: window.offset })
        if (selector.source === "cleanups") for (const value of rows) {
          const before = target.inventoryRows?.get(JSON.stringify([(value as { missionID: string }).missionID, (value as { deletionID: string }).deletionID]))
          if (before && ["missionID", "requestID", "expectedRevision", "deleteManagedSessions", "createdAt"].some(key =>
            (before.value as Record<string, unknown>)[key] !== (value as Record<string, unknown>)[key])) throw new MissionTaskPageReadError("invalid")
        }
        const pages = new Map(target.pages), old = pages.get(window.offset)
        let inventoryRows = target.inventoryRows
        if (!old || old.epoch !== own.epoch || (old.revision ?? 0) <= (answer.envelope.revision ?? 0)) pages.set(window.offset, { values: rows, window, revision: answer.envelope.revision, observedAt: answer.envelope.observedAt, serial, epoch: own.epoch, cycle })
        if (selector.source === "summaries" || selector.source === "cleanups") {
          const retained = inventoryRows = new Map(target.inventoryRows), keyOf = (value: unknown) => selector.source === "summaries" ? (value as { id: string }).id : JSON.stringify([(value as { missionID: string }).missionID, (value as { deletionID: string }).deletionID])
          for (const value of rows) {
            const id = keyOf(value), revision = selector.source === "summaries" ? (value as { revision: number }).revision : 0, before = retained.get(id)
            if (!before || before.epoch !== own.epoch || before.revision < revision || before.revision === revision && before.serial < serial) retained.set(id, { value, revision, serial, epoch: own.epoch })
          }
          let end = 0
          for (const page of [...pages.values()].sort((a, b) => a.window.offset - b.window.offset)) {
            if (page.window.order !== window.order || page.window.offset !== end) break
            end = page.window.end
          }
          if (end === window.total) {
            const present = new Set([...pages.values()].filter(page => page.window.order === window.order).flatMap(page => page.values.map(keyOf)))
            for (const id of retained.keys()) if (!present.has(id)) retained.delete(id)
          }
        }
        assertTaskReadLive(life.signal, life.deadline)
        if (!life.current()) return
        target.pages = pages; target.inventoryRows = inventoryRows
        if (advancing) target.cycle = cycle
        // Only this exact failed window can clear its failure.
        target.failures.delete(signature)
        for (const [id, failure] of target.failures) if (offsetOf(failure.selector) === window.offset && (orderOf(failure.selector) === undefined || orderOf(failure.selector) === window.order)) target.failures.delete(id)
        if (window.offset === 0) for (const [id, failure] of target.failures) {
          const oldOrder = orderOf(failure.selector)
          if (superseded?.get(id) === failure) target.failures.delete(id)
          else if (oldOrder !== undefined && oldOrder !== window.order) failure.changed = true
        }
        target.failed = target.failures.values().next().value
      } catch (error) {
        if (selector.source === "summaries" && !own.seeded && error instanceof MissionTaskPageReadError && ["invalid", "damaged", "too-large"].includes(error.reason)) own.baseline = undefined
        failed(error)
        throw error
      } finally { target.loading = false; if (target.pending === operation) { target.pending = undefined; target.pendingSelector = undefined }; changed() }
    }
    operation = (waiting ?? Promise.resolve()).catch(() => {}).then(run)
    target.pending = operation; target.pendingSelector = signature; target.pendingCurrent = life.current
    return raceTaskRead(operation, life.signal).catch(error => { failed(error); changed(); throw error })
  }
  async function readMap(instanceId: string, id: string, own: Entry, parent: MissionPanelReadScope): Promise<MissionPanelMap> {
    const ownLife = scope(instanceId, own, id, parent.deadline)
    const life = { ...ownLife, signal: AbortSignal.any([ownLife.signal!, parent.signal!]), current: () => ownLife.current() && parent.current() }
    const answer = await raceTaskRead(input.read(instanceId, { source: "mission", missionID: id, header: true }, life), life.signal)
    if (!life.current()) throw new DOMException("Obsolete mission owner", "AbortError")
    adopt(own, answer)
    if (answer.values.length !== 1) throw new MissionTaskPageReadError("invalid")
    const header = panelHeaderSchema.parse(answer.values[0])
    if (header.root.id !== id || header.root.projectID !== own.projectID || header.root.revision !== answer.envelope.revision) throw new MissionTaskPageReadError("invalid")
    const previous = own.maps.get(id)
    let map: MissionPanelMap = { ...header.root, actors: header.coordinator ? [header.coordinator] : [], tasks: [], reports: [], history: [], panelControl: header.control,
      panelCollections: header.collections } as MissionPanelMap
    if (previous?.header.tasks.version === header.tasks.version && JSON.stringify(previous.header.tasks.pins) === JSON.stringify(header.tasks.pins)) {
      map = { ...map, tasks: previous.map.tasks, reports: previous.map.reports, taskPage: header.tasks.page }
    } else if (header.tasks.page.total || header.tasks.reportPins.length) {
      const tasks = await input.tasks(instanceId, id, { offset: 0 }, { ...life, projectID: own.projectID!, signal: life.signal!, deadline: life.deadline! })
      if (!tasks.available || !("tasks" in tasks)) throw new MissionTaskPageReadError("unavailable")
      if (tasks.revision !== header.root.revision) throw new MissionTaskPageReadError("changed")
      map = { ...map, tasks: tasks.tasks, reports: tasks.reports, taskPage: header.tasks.page }
      if (header.tasks.pins.length || header.tasks.reportPins.length) {
        const pins = await input.tasks(instanceId, id, { ids: header.tasks.pins, reportIds: header.tasks.reportPins }, { ...life, projectID: own.projectID!, signal: life.signal!, deadline: life.deadline! })
        if (!pins.available || !("tasks" in pins) || pins.revision !== header.root.revision) throw new MissionTaskPageReadError("changed")
        map = { ...map, tasks: [...map.tasks, ...pins.tasks], reports: [...new Map([...map.reports, ...pins.reports].map(report => [report.id, report])).values()] }
      }
    } else map.taskPage = header.tasks.page
    assertTaskReadLive(life.signal, life.deadline)
    if (!life.current()) throw new DOMException("Obsolete mission owner", "AbortError")
    for (const target of own.lanes.values()) if (target.field?.missionID === id && target.field.field) {
      const field = target.field.field, before = previous?.header.collections[field], after = header.collections[field]
      if (before && after && before.digest !== after.digest && target.pages.size) {
        const selector: Selector = { source: "mission", ...target.field, window: { offset: 0 } }
        target.failures.set(`header:${after.digest}`, { selector, changed: true }); target.failed = target.failures.values().next().value
      }
    }
    // The selected source alone observes actor roots. Additional windows are explicit.
    recordMissionTaskSource(map, header.tasks.version)
    own.maps.set(id, { header, map, epoch: own.epoch })
    void readLane(instanceId, `activity:${id}`, { source: "activity", missionID: id }).catch(() => {})
    return map
  }
  const base = createMissionStore(async (instanceId, request): Promise<MissionDisplayResponse> => {
    const own = entry(instanceId)
    const life = scope(instanceId, own, undefined, own.refreshDeadline)
    await readLane(instanceId, "summaries", { source: "summaries", window: { offset: 0 }, ...(own.baseline === undefined ? { initial: true as const } : {}) }, life)
    await readLane(instanceId, "cleanups", { source: "cleanups", window: { offset: 0 } }, life).catch(() => {})
    const wanted = new Set([...own.owners.values()].map(owner => owner.id))
    const maps = [...own.maps.values()].filter(value => wanted.has(value.map.id)).map(value => value.map)
    if (!life.current()) throw new DOMException("Obsolete panel read", "AbortError")
    assertTaskReadLive(life.signal, life.deadline)
    if (own.panel) void readLane(instanceId, "marks", { source: "marks", missionOffset: 0 }).catch(() => {})
    const summaries = summaryRows(own, maps)
    return { available: true, version: 1, projectID: own.projectID!, generatedAt: Date.now(), discardedEvents: 0, missions: maps, summaries, panelDeadline: life.deadline, panelCurrent: life.current,
      activity: activity(own), cleanups: values(own, "cleanups") as NonNullable<Extract<MissionListResponse, { available: true }>["cleanups"]>,
      cleanupUnavailable: Boolean(own.lanes.get("cleanups")?.failed) }
  }, (instanceId, id, request, parent) => {
    const own = entry(instanceId), life = scope(instanceId, own, id)
    return input.tasks(instanceId, id, request, { ...parent, signal: AbortSignal.any([parent.signal, life.signal!]), current: () => parent.current() && life.current() })
  }, true)
  const summaryRows = (own: Entry, maps: MissionPanelMap[]): MissionSummary[] => {
    const rows = new Map((values(own, "summaries") as Array<ReturnType<typeof panelSummarySchema.parse>>).map(row => [row.id, { ...row, actorSessionIds: [] as string[] }]))
    for (const map of maps) if (!rows.has(map.id) || own.lanes.get("summaries")?.inventoryRows?.get(map.id)?.epoch !== own.epoch || rows.get(map.id)!.revision < map.revision) rows.set(map.id, { id: map.id, title: map.title, objective: map.excerpt ?? "", status: map.status,
      runState: map.runState, revision: map.revision, coordinatorSessionId: map.coordinatorSessionId, actorSessionIds: [], actorCount: own.maps.get(map.id)?.header.collections.actors?.total ?? 0,
      updatedAt: map.updatedAt, finishSequence: map.finishSequence })
    return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }
  const more = async (instanceId: string, key: string, retry = false, at?: number) => {
    const own = entry(instanceId), target = lane(own, key), first = target.pages.get(0), state = progress(instanceId, key)
    if (!own.panel && ![...own.owners.values()].some(item => item.reader)) return
    let selector: Selector
    if (retry && target.failed && !target.failed.changed) selector = target.failed.selector
    else {
      const offset = at ?? (retry ? 0 : state.loaded), order = retry ? undefined : first?.window.order
      if (key === "summaries" || key === "cleanups") selector = { source: key, window: { offset, order } }
      else if (key === "marks") selector = { source: "marks", missionOffset: offset, missionOrder: order }
      else if (key.startsWith("activity:")) selector = { source: "activity", missionID: key.slice(9), actorOffset: offset, actorOrder: order }
      else if (target.field) selector = { source: "mission", ...target.field, window: { offset, order } }
      else { const [kind, id, field, part] = key.split(":"); selector = { source: "mission", missionID: id, field, ...(kind === "text" ? { text: true as const } : {}), ...(part === "receipts" || part === "pending" ? { part } : {}), window: { offset, order } } }
    }
    await readLane(instanceId, key, selector, undefined, retry && offsetOf(selector) === 0 && orderOf(selector) === undefined).catch(() => {})
  }
  const stop = (own: Entry) => {
    if (own.panel || [...own.owners.values()].some(item => item.reader)) return
    own.controller.abort(); own.epoch++
  }
  const publishHeaders = (instanceId: string, own: Entry, deadline: number) => {
    if (!own.projectID) return
    const ids = new Set([...own.owners.values()].map(owner => owner.id))
    base.adoptPanelMaps(instanceId, own.projectID, [...own.maps.values()].filter(value => ids.has(value.map.id)).map(value => value.map), deadline)
  }
  const refreshMap = async (instanceId: string, id: string, explicit: boolean, initial = false) => {
    const own = entry(instanceId), known = own.headerErrors.get(id)
    const row = (values(own, "summaries") as Array<{ id: string; revision: number }>).find(row => row.id === id)
    if (!explicit && known && (row?.revision ?? -1) <= known.revision) return
    const life = scope(instanceId, own, id), owner = own.missionOwners.get(id)!, waiting = own.headerReads.get(id)
    if (waiting?.owner === owner) { if (!initial) waiting.trailing = true; await waiting.promise; return }
    if (initial && own.maps.get(id)?.epoch === own.epoch) return
    const job = { owner, trailing: false, promise: Promise.resolve() }
    const run = async () => {
      try {
        do {
          job.trailing = false
          try {
            await readMap(instanceId, id, own, life)
            if (!life.current()) return
            own.missing.delete(id); own.headerErrors.delete(id)
          } catch (error) {
            if (!life.current()) return
            if (!(error instanceof MissionPanelMissingError)) throw error
            own.maps.delete(id); own.missing.add(id); own.headerErrors.delete(id)
          }
          assertTaskReadLive(life.signal, life.deadline)
          publishHeaders(instanceId, own, life.deadline!)
        } while (job.trailing && life.current())
      } catch (error) {
        if (life.current()) own.headerErrors.set(id, { revision: row?.revision ?? -1, reason: error instanceof MissionTaskPageReadError && error.reason === "changed" ? "changed" : "failed",
          unavailableReason: error instanceof MissionTaskPageReadError ? error.unavailableReason : undefined })
      } finally { if (own.headerReads.get(id) === job) own.headerReads.delete(id); changed() }
    }
    own.headerReads.set(id, job); job.promise = Promise.resolve().then(run)
    return job.promise
  }
  const refresh = async (instanceId: string, initial = false, explicit = true) => {
    const own = entry(instanceId), deadline = own.refreshDeadline ??= performance.now() + TASK_READ_TIMEOUT_MS
    try { await Promise.all([initial ? base.ensure(instanceId) : base.refresh(instanceId), ...[...new Set([...own.owners.values()].filter(owner => own.panel || owner.reader).map(owner => owner.id))].map(id => refreshMap(instanceId, id, explicit, initial))]) }
    finally { if (own.refreshDeadline === deadline) own.refreshDeadline = undefined }
  }
  const mergeField = <T>(own: Entry, map: MissionPanelMap, field: string, baseRows: T[], key: (row: T) => string | number): T[] => {
    if (!own.lanes.get(`field:${map.id}:${field}`)?.pages.size) return baseRows
    const rows = new Map(baseRows.map(row => [key(row), { row, revision: map.revision }]))
    for (const page of own.lanes.get(`field:${map.id}:${field}`)?.pages.values() ?? []) for (const row of page.values as T[]) {
      if (page.epoch !== own.epoch && field === "actors") continue
      const revision = page.epoch === own.epoch ? page.revision ?? 0 : 0
      if (page.epoch !== own.epoch && row !== null && typeof row === "object") recordMissionRowRevision([row], 0)
      const id = key(row), current = rows.get(id)
      if (!current || current.revision < revision) rows.set(id, { row, revision })
    }
    return [...rows.values()].map(value => value.row)
  }
  return { ...base, bounded: true as const, progress, more, observations,
    observedActors: (instanceId: string, id: string) => {
      version(); const own = entries.get(instanceId)
      return own ? (values(own, `activity:${id}`) as PanelObservation[]).filter(page => currentObservation(own, page)).flatMap(page => page.context.actors) : []
    },
    refresh: (instanceId: string, explicit = true) => refresh(instanceId, false, explicit),
    ensure: (instanceId: string) => refresh(instanceId, true, false),
    mapMissing: (instanceId: string, id: string) => { version(); return entries.get(instanceId)?.missing.has(id) ?? false },
    fieldValues: (instanceId: string, id: string, field: string): unknown[] => { version(); const own = entries.get(instanceId); return own ? values(own, `field:${id}:${field}`) : [] },
    fieldText: (instanceId: string, id: string, field: string, page: number): string | undefined => {
      version(); return entries.get(instanceId)?.lanes.get(`text:${id}:${field}`)?.pages.get(page)?.values[0] as string | undefined
    },
    state: (instanceId: string) => {
      version(); const shown = base.state(instanceId), own = entries.get(instanceId)
      if (!own?.projectID) return shown
      const missions = shown.missions.map(map => {
        const actors = mergeField(own, map, "actors", map.actors, actor => actor.sessionId),
          reports = mergeField(own, map, "reports", map.reports, report => report.id),
          history = mergeField(own, map, "history", map.history, change => change.revision)
        return actors === map.actors && reports === map.reports && history === map.history ? map : { ...map, actors, reports, history }
      })
      const failed = [...own.owners.values()].some(owner => own.headerErrors.has(owner.id))
      const unavailable = [...own.owners.values()].map(owner => own.headerErrors.get(owner.id)?.unavailableReason).find(Boolean)
      return { ...shown, ...(shown.status === "unavailable" ? {} : unavailable ? { status: "unavailable" as const, reason: unavailable, error: undefined } : failed ? { status: "error" as const } : {}), missions, summaries: summaryRows(own, missions), activity: activity(own),
        cleanups: values(own, "cleanups") as typeof shown.cleanups, cleanupUnavailable: Boolean(own.lanes.get("cleanups")?.failed) }
    },
    setDemand: (instanceId: string, demanded: boolean) => { const own = entry(instanceId); own.panel = demanded; if (!demanded) stop(own); base.setDemand(instanceId, demanded) },
    want: (instanceId: string, owner: string, id: string | undefined, reader = false) => untrack(() => {
      const own = entry(instanceId), old = own.owners.get(owner)?.id, alreadyWanted = id !== undefined && [...own.owners.values()].some(value => value.id === id)
      if (id) own.owners.set(owner, { id, reader }); else own.owners.delete(owner)
      if (old && old !== id && ![...own.owners.values()].some(item => item.id === old)) {
        own.missionOwners.get(old)?.abort(); own.missionOwners.delete(old)
        own.headerErrors.delete(old); own.missing.delete(old)
        for (const key of own.lanes.keys()) if (key === `activity:${old}` || key.startsWith(`field:${old}:`) || key.startsWith(`text:${old}:`)) own.lanes.delete(key)
      }
      base.want(instanceId, owner, id, reader); stop(own)
      if (old !== id) publishHeaders(instanceId, own, Infinity)
      if (own.controller.signal.aborted) base.setDemand(instanceId, false)
      else if (id && !alreadyWanted && (own.panel || reader)) void refreshMap(instanceId, id, true)
    }),
    invalidateTasks: (instanceId: string) => {
      const own = entries.get(instanceId)
      if (own) { own.controller.abort(); own.epoch++; own.controller = new AbortController(); own.headerErrors.clear(); own.missing.clear(); own.headerReads.clear() }
      base.invalidateTasks(instanceId)
    },
    clear: (instanceId: string) => { entries.get(instanceId)?.controller.abort(); entries.delete(instanceId); base.clear(instanceId); changed() },
  }
}
