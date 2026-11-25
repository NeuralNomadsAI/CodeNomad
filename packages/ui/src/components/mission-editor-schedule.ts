import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import type { MissionPanelMap, MissionScheduleRead } from "../../../server/src/api-types"
import { partialMissionScheduleReceipt, refusedMissionScheduleReceipt, type MissionScheduleControlReceipt } from "../lib/mission-schedule-receipt"
import { backendOf } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { HttpResponseError } from "../lib/retryable-file-search"
import { MissionMutationError } from "../lib/mission-mutation"
import { backendEvents as serverEvents } from "../lib/server-events"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { instances } from "../stores/instances"
import type { MissionEditorAction, MissionEditorDraft } from "../stores/mission-editor-state"
import { exactMissionScheduleEditorReceipt, holdMissionScheduleEditor, missionScheduleEditorHold, onMissionScheduleEditorSettled,
  releaseMissionScheduleEditor, resumeMissionScheduleEditor, retainMissionScheduleEditor, type MissionEditorConfiguration,
  type MissionScheduleEditorRequest, type MissionJournalEditRequest } from "../stores/mission-schedule-editor-holds"
import { decodeMissionSchedulingPolicy } from "./mission-scheduling-decode"
import { newMissionSchedulingDraft } from "./mission-scheduling-data"
import { readMissionEditorBody } from "./mission-editor-body"
import { rereadMissionHoldWhileActive } from "../lib/mission-held-reread"

type Document = NonNullable<MissionScheduleRead["document"]>
export function createMissionEditorScheduling(props: {
  instanceId: string; directory?: string; action: MissionEditorAction; draft?: Readonly<MissionEditorDraft>
  /** Scalar view identity; with the client and native generation, it owns the shown reads. */
  scope: () => string; owner: () => string; active: () => boolean; captureView: () => (() => boolean)
  onLoad: (configuration: Document["configuration"]) => void
  captureDraft: () => MissionEditorDraft; onSaved: (mission?: MissionPanelMap, scheduleID?: string) => void
}) {
  const target = props.action.scheduleID ?? props.action.mission?.id
  const unified = props.action.kind === "edit" && !!(props.action.scheduleID || props.action.mission?.document)
  const [document, setDocument] = createSignal<Document | undefined>(props.draft?.scheduleDocument)
  const [journal, setJournal] = createSignal(props.draft?.journalMission ?? props.action.mission)
  const [scheduling, setScheduling] = createSignal(props.draft?.scheduling ?? newMissionSchedulingDraft())
  const [previousDraft, setPreviousDraft] = createSignal(props.draft?.previousDraft)
  const [ready, setReady] = createSignal(!unified), [failed, setFailed] = createSignal(false)
  const [conflict, setConflict] = createSignal(false), [reading, setReading] = createSignal(false)
  const [refresh, setRefresh] = createSignal(0)
  const [capability, setCapability] = createSignal<"loading" | "missing" | "activatable" | "available">("loading")
  const [directory, setDirectory] = createSignal(props.draft?.scheduleDocument?.configuration.roots[0]?.directory)
  const adopt = (doc: Document) => {
    if (!directory()) setDirectory(doc.configuration.roots[0]?.directory)
    setDocument(doc); props.onLoad(doc.configuration)
    setScheduling(decodeMissionSchedulingPolicy(doc.configuration.launch, doc.configuration.roots[0]?.directory))
    setConflict(false); setReady(true)
  }
  // Only a changed view, client or native generation is another owner: other
  // publications (task revisions, transcript releases) never reread or reset.
  const owner = createMemo(() => ({ key: props.owner(), client: instances().get(props.instanceId)?.client,
    signal: captureBackendOperation(props.instanceId).signal,
    generation: getOpenCodeInstanceGeneration(props.instanceId) }), undefined,
  { equals: (a, b) => !!a && a.signal === b.signal && a.key === b.key && a.client === b.client && a.generation === b.generation })
  // Passive display reads are fenced by their owner, so a panel operation that
  // only retires mutation fences never strands them; mutations keep captureView.
  const captureOwner = (controller: AbortController) => {
    const origin = owner()
    return () => !origin.signal.aborted && !controller.signal.aborted && owner() === origin && props.active()
  }
  // One capability read at a time, with at most one trailing read; the same
  // owner keeps its last display while it revalidates.
  let capabilityRead: { controller: AbortController; trailing: boolean } | undefined
  const [capabilityReading, setCapabilityReading] = createSignal(false)
  const [documentReading, setDocumentReading] = createSignal(false)
  const readCapability = () => untrack(() => {
    if (!props.active()) return
    if (capabilityRead) { capabilityRead.trailing = true; return }
    const controller = new AbortController(), read = capabilityRead = { controller, trailing: false }
    const owned = captureOwner(controller), current = () => capabilityRead === read && owned()
    setCapabilityReading(true)
    void backendOf(props.instanceId).api.fetchMissionScheduleCapability(props.instanceId, props.directory,
      AbortSignal.any([owner().signal, controller.signal, AbortSignal.timeout(10_000)])).then(value => {
      if (!current()) return
      if (value.location?.directory) setDirectory(value.location.directory)
      setCapability(value.api?.available ? value.enabled ? "available" : value.activation?.available ? "activatable" : "missing" : "missing")
    }).catch(() => { if (current()) setCapability("missing") }).finally(() => {
      if (capabilityRead !== read) return
      capabilityRead = undefined; setCapabilityReading(false)
      if (read.trailing && owned()) readCapability()
    })
  })
  const stopCapability = () => { capabilityRead?.controller.abort(); capabilityRead = undefined; setCapabilityReading(false) }
  let documentRead: AbortController | undefined
  const readDocument = () => untrack(() => {
    documentRead?.abort(); documentRead = undefined; setDocumentReading(false)
    if (!unified || !target || !props.active()) return
    const controller = documentRead = new AbortController(), owned = captureOwner(controller)
    const current = () => documentRead === controller && owned()
    setFailed(false); setDocumentReading(true)
    void backendOf(props.instanceId).api.fetchMissionSchedule(props.instanceId, target, { directory: props.directory },
      AbortSignal.any([owner().signal, controller.signal, AbortSignal.timeout(10_000)])).then(result => {
      if (!current()) return
      const doc = result.document
      if (!doc || doc.id !== target || !doc.configuration || !doc.edit) throw new Error("Mission document unavailable")
      // A restored draft owns its revision. A refresh may reveal a conflict,
      // but only explicit Reload adopts another revision/configuration.
      if (!document()) adopt(doc)
      else {
        const changed = document()!.revision !== doc.revision
        if (!changed) setDocument(doc) // Refresh observation/locks, retaining the editable draft.
        setConflict(changed); setReady(true)
      }
    }).catch(() => { if (current()) { setFailed(true); setReady(false) } }).finally(() => {
      if (documentRead === controller) { documentRead = undefined; setDocumentReading(false) }
    })
  })
  let reconcileRead: AbortController | undefined
  const stopReconcile = () => { reconcileRead?.abort(); reconcileRead = undefined }
  let previousOwner: ReturnType<typeof owner> | undefined
  const visible = createMemo(() => props.active())
  createEffect(() => {
    const value = owner(), active = visible()
    untrack(() => {
      const changed = Boolean(previousOwner && value !== previousOwner)
      if (changed) { setCapability("loading"); if (unified) setReady(false) }
      previousOwner = value
      stopCapability(); stopReconcile(); if (active) readCapability()
      readDocument()
      if (active && changed && held()?.state === "uncertain") void reconcile()
    })
  })
  createEffect(on(refresh, () => { readCapability(); readDocument() }, { defer: true }))
  // A config event does not say which layer changed: every visible editor of the
  // instance revalidates its capability, as do native and backend reconnections.
  const stopEvents = [
    serverEvents.on("instance.event", event => {
      if (event.type === "instance.event" && event.instanceId === props.instanceId
        && (event.event.type === "config.updated" || event.event.type === "plugin.updated")) readCapability()
    }),
    serverEvents.on("instance.eventStatus", event => {
      if (event.type === "instance.eventStatus" && event.instanceId === props.instanceId && event.status === "connected") readCapability()
    }),
    serverEvents.forInstance(() => props.instanceId).onOpen(readCapability),
  ]
  onCleanup(() => { stopEvents.forEach(stop => stop()); stopCapability(); stopReconcile(); documentRead?.abort(); documentRead = undefined })
  const held = () => missionScheduleEditorHold(props.scope())
  const comparison = () => {
    const { titleOverride, objective, notes, template, profiles, taskMode, watched, scheduling } = props.captureDraft()
    const { stored, ...fields } = scheduling ?? newMissionSchedulingDraft()
    return JSON.stringify({ title: titleOverride, objective, notes, template, profiles, taskMode, watched,
      scheduling: fields, storedPolicy: stored?.policy }, null, 2)
  }
  const capture = () => captureBackendOperation(props.instanceId, undefined, props.captureView()).current
  const readBody = (mission: MissionPanelMap, selector: Parameters<typeof readMissionEditorBody>[1], current: () => boolean, abort?: AbortSignal) => {
    const operation = captureBackendOperation(props.instanceId, abort ? AbortSignal.any([abort, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), current)
    return readMissionEditorBody(mission, selector, query => {
      if (!operation.current()) throw new DOMException("Stale Mission read", "AbortError")
      return backendOf(props.instanceId).api.fetchMissionContent(props.instanceId, mission.id, query, operation.signal).then(value => {
        if (!operation.current()) throw new DOMException("Stale Mission read", "AbortError")
        return value
      })
    })
  }
  const readText = async (mission: MissionPanelMap, current: () => boolean, abort?: AbortSignal) => {
    const objective = await readBody(mission, { kind: "mission", field: "objective" }, current, abort)
    const notes = await readBody(mission, { kind: "mission", field: "notes" }, current, abort)
    if (typeof objective !== "string" || notes !== undefined && typeof notes !== "string") throw new Error("Mission text unavailable")
    return { objective, notes: notes as string | undefined }
  }
  async function reload() {
    if (held() || reading() || !target || !props.active()) return
    const current = capture()
    if (!current()) return
    setReading(true); setFailed(false); setReady(false)
    try {
      if (!props.action.scheduleID && (!unified || document()?.kind === "one-time")) {
        const snapshot = await backendOf(props.instanceId).api.fetchMission(props.instanceId, target)
        if (!current()) return
        if (!snapshot.available || !snapshot.mission || snapshot.controlUnavailable || snapshot.notificationUnavailable) throw new Error("Mission journal unavailable")
        const mission = snapshot.mission
        const text = await readText(mission, current)
        if (!current()) return
        if (unified) {
          const read = await backendOf(props.instanceId).api.fetchMissionSchedule(props.instanceId, target, { directory: props.directory })
          if (!current()) return
          if (!read.document || read.document.configuration.objective !== text.objective
            || (read.document.configuration.notes ?? "") !== (text.notes ?? "")) throw new Error("Mission document unavailable")
          setPreviousDraft(comparison()); setJournal(mission)
          adopt(read.document)
        } else {
          setPreviousDraft(comparison()); setJournal(mission)
          props.onLoad({ ...mission, ...text, title: mission.title ?? "", taskMode: mission.taskMode ?? "native", roots: [],
            profileID: null, executionHost: null, watchedConversationIDs: [], launch: { when: [] } })
          setConflict(false); setReady(true)
        }
        return
      }
      const result = await backendOf(props.instanceId).api.fetchMissionSchedule(props.instanceId, target, { directory: props.directory })
      if (!current()) return
      if (!result.document || result.document.id !== target) throw new Error("Mission document unavailable")
      setPreviousDraft(comparison()); adopt(result.document)
    } catch { if (current()) setFailed(true) }
    finally { setReading(false) }
  }
  async function saveJournalEdit(input: Omit<MissionJournalEditRequest, "missionID" | "expectedRevision">) {
    if (held() || !journal()) return
    const scope = props.scope(), current = capture(), original = journal()!
    if (!current()) return
    const request = { ...input, missionID: original.id, expectedRevision: original.revision }
    if (!holdMissionScheduleEditor(scope, request, props.captureDraft())) return
    try {
      const result = await backendOf(props.instanceId).api.editMission(props.instanceId, original.id, { objective: input.objective, notes: input.notes,
        requestId: input.requestID, expectedRevision: original.revision })
      if (result.mission.id !== original.id) throw new Error("Mission edit ACK differs")
      releaseMissionScheduleEditor(scope, request.requestID)
      if (current()) props.onSaved(result.mission)
    } catch (error) {
      if (error instanceof MissionMutationError && ([400, 401, 403, 404].includes(error.status)
        || error.status === 409 && ["revision-conflict", "request-conflict"].includes(error.code ?? ""))) {
        releaseMissionScheduleEditor(scope, request.requestID)
        if (current() && error.code === "revision-conflict") { setConflict(true); return }
        throw error
      }
      retainMissionScheduleEditor(scope, request.requestID)
    }
  }
  async function save(configuration: MissionEditorConfiguration, requestID: string,
    onCreated?: (document: Document) => Promise<void>) {
    if (held()) return "uncertain" as const
    const scope = props.scope(), current = capture()
    if (!current()) return "stale" as const
    // A stale editor is refused before dispatch, so explicit Reload can safely
    // retain the old draft without clearing an uncertain native mutation.
    if (unified && target) {
      const latest = await backendOf(props.instanceId).api.fetchMissionSchedule(props.instanceId, target, { directory: props.directory })
      if (!current()) return "stale" as const
      if (!latest.document || latest.document.id !== target || latest.document.revision !== document()?.revision) { setConflict(true); return "conflict" as const }
      if (latest.pending || latest.document.edit.reason === "uncertain" || latest.document.observation.state === "unknown") {
        setDocument(latest.document); return "blocked" as const
      }
    }
    if (!current()) return "stale" as const
    const request: MissionScheduleEditorRequest = { action: unified ? "configure" : "create", requestID,
      expectedRevision: unified ? document()!.revision : 0, ...(unified ? { missionID: target } : {}),
      directory: props.directory, configuration }
    if (!holdMissionScheduleEditor(scope, request, props.captureDraft())) return "uncertain" as const
    try {
      const result = await backendOf(props.instanceId).api.saveMissionSchedule(props.instanceId, request)
      if (!exactMissionScheduleEditorReceipt(request, result)) throw new Error("Unconfirmed Mission schedule receipt")
      releaseMissionScheduleEditor(scope, requestID)
      // Only the direct create ACK may continue the captured user intention.
      // Receipt recovery and partial preparation retries stay observation-only.
      if (request.action === "create" && current() && onCreated) {
        try { await onCreated(result.document!) } catch { /* Creation is already confirmed; its start has its own holder. */ }
      }
      if (current()) props.onSaved(undefined, result.document?.id)
      return "saved" as const
    } catch (error) {
      if (refusedMissionScheduleReceipt(error, request, request.missionID)) {
        releaseMissionScheduleEditor(scope, requestID)
        if (current()) setConflict(true)
        return "conflict" as const
      }
      if (error instanceof HttpResponseError && (error.code === "schedule-input-invalid" || error.code === "schedule-human-required")) {
        releaseMissionScheduleEditor(scope, requestID); throw error
      }
      retainMissionScheduleEditor(scope, requestID)
      return "uncertain" as const
    }
  }
  async function reconcile() {
    const hold = held()
    if (!hold || hold.state !== "uncertain" || reading() || reconcileRead || !props.active()) return
    const viewCurrent = capture(), scope = props.scope(), readOwner = owner()
    if (!viewCurrent()) return
    const controller = reconcileRead = new AbortController()
    const owned = captureOwner(controller)
    const signal = AbortSignal.any([readOwner.signal, controller.signal, AbortSignal.timeout(30_000)])
    const current = () => viewCurrent() && owned() && reconcileRead === controller && !signal.aborted
    const request: MissionScheduleEditorRequest | MissionJournalEditRequest = JSON.parse(hold.payload)
    try {
      if (!("action" in request)) {
        const read = await backendOf(props.instanceId).api.fetchMission(props.instanceId, request.missionID, signal)
        if (!current()) return
        const mission = read.available && !read.controlUnavailable && !read.notificationUnavailable ? read.mission : undefined
        const change = mission?.history.find(change => change.source === "user" && change.requestID === request.requestID
          && change.revision === request.expectedRevision + 1)
        if (!mission || !change) return
        const objective = await readBody(mission, { kind: "change", change: change.revision, field: "objective" }, current, signal) as { after?: string } | undefined
        const notes = await readBody(mission, { kind: "change", change: change.revision, field: "notes" }, current, signal) as { after?: string } | undefined
        if (objective?.after !== request.objective || notes?.after !== request.notes) return
        if (mission.document) {
          const text = await readText(mission, current, signal)
          if (!current()) return
          const state = await backendOf(props.instanceId).api.fetchMissionSchedule(props.instanceId, request.missionID, { directory: props.directory }, signal)
          if (!current()) return
          if (!state.document || state.document.configuration.objective !== text.objective
            || (state.document.configuration.notes ?? "") !== (text.notes ?? "")) return
        }
        releaseMissionScheduleEditor(scope, request.requestID)
        if (current()) props.onSaved(mission)
        return
      }
      const result = await (request.missionID
        ? backendOf(props.instanceId).api.fetchMissionSchedule(props.instanceId, request.missionID, { directory: request.directory, requestID: request.requestID }, signal)
        : backendOf(props.instanceId).api.fetchMissionScheduleCreation(props.instanceId, request.requestID, request.directory, signal))
        .catch(error => { const partial = partialMissionScheduleReceipt(error); if (partial) return partial; throw error })
      if (!current()) return
      if (exactMissionScheduleEditorReceipt(request, result)) {
        releaseMissionScheduleEditor(scope, request.requestID)
        if (current()) props.onSaved(undefined, result.document?.id)
        return
      }
      if (!request.missionID || !partialPreparation(request, result)) return
      if (held()?.state !== "uncertain" || held()?.payload !== hold.payload) return
      if (!resumeMissionScheduleEditor(scope, request.requestID)) return
      let released = false
      try {
        const retried = await backendOf(props.instanceId).api.saveMissionSchedule(props.instanceId, { ...request, retry: true },
          AbortSignal.any([readOwner.signal, AbortSignal.timeout(30_000)]))
        if (!exactMissionScheduleEditorReceipt(request, retried)) return
        const notified = releaseMissionScheduleEditor(scope, request.requestID, { scheduleID: retried.document?.id })
        released = true
        if (!notified && viewCurrent() && !readOwner.signal.aborted && owner() === readOwner) props.onSaved(undefined, retried.document?.id)
      } finally {
        if (!released) retainMissionScheduleEditor(scope, request.requestID)
      }
    } catch { /* Only a positive original receipt settles an unknown write. */ }
    finally { if (reconcileRead === controller) reconcileRead = undefined }
  }
  function partialPreparation(request: MissionScheduleEditorRequest, result: MissionScheduleRead | MissionScheduleControlReceipt) {
    const doc = result.document, receipt = doc?.control
    return request.action === "configure" && (doc?.kind === "one-time" || doc?.dormant === true) && doc.id === request.missionID && result.pending === true
      && receipt?.action === request.action && receipt.requestID === request.requestID
      && receipt.expectedRevision === request.expectedRevision && receipt.pending === true
  }
  createEffect(() => {
    const scope = props.scope()
    onCleanup(onMissionScheduleEditorSettled(scope, (_requestID, settled) => {
      if (!props.active() || !capture()()) return false
      props.onSaved(settled.mission, settled.scheduleID)
      return true
    }))
  })
  rereadMissionHoldWhileActive(() => held()?.state === "uncertain", props.active, reconcile)
  return { unified, document, journal, scheduling, setScheduling, previousDraft, ready, failed, conflict, reading, capability, directory,
    revalidating: () => capabilityReading() || documentReading(),
    held, save, saveJournalEdit, reconcile, reload, retryRead: () => setRefresh(value => value + 1) }
}
