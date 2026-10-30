import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import type { MissionPanelMap, MissionScheduleRead } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { HttpResponseError } from "../lib/retryable-file-search"
import { MissionMutationError } from "../lib/mission-mutation"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import type { MissionEditorAction, MissionEditorDraft } from "../stores/mission-editor-state"
import { exactMissionScheduleEditorReceipt, holdMissionScheduleEditor, missionScheduleEditorHold,
  releaseMissionScheduleEditor, retainMissionScheduleEditor, type MissionEditorConfiguration,
  type MissionScheduleEditorRequest, type MissionJournalEditRequest } from "../stores/mission-schedule-editor-holds"
import { decodeMissionSchedulingPolicy } from "./mission-scheduling-decode"
import { newMissionSchedulingDraft } from "./mission-scheduling-data"
import { readMissionEditorBody } from "./mission-editor-body"

type Document = NonNullable<MissionScheduleRead["document"]>
export function createMissionEditorScheduling(props: {
  instanceId: string; directory?: string; action: MissionEditorAction; draft?: Readonly<MissionEditorDraft>
  scope: () => string; active: () => boolean; captureView: () => (() => boolean)
  onLoad: (configuration: Document["configuration"]) => void
  captureDraft: () => MissionEditorDraft; onSaved: (mission?: MissionPanelMap, scheduleID?: string) => void
}) {
  const target = props.action.scheduleID ?? props.action.mission?.id
  const unified = props.action.kind === "edit" && !!(props.action.scheduleID || props.action.mission?.document)
  const [document, setDocument] = createSignal<Document | undefined>(props.draft?.scheduleDocument)
  const [journal, setJournal] = createSignal(props.draft?.journalMission ?? props.action.mission)
  const [scheduling, setScheduling] = createSignal(props.draft?.scheduling ?? newMissionSchedulingDraft())
  const [anchorAt, setAnchorAt] = createSignal(props.draft?.scheduleAnchorAt ?? Date.now())
  const [previousDraft, setPreviousDraft] = createSignal(props.draft?.previousDraft)
  const [ready, setReady] = createSignal(!unified), [failed, setFailed] = createSignal(false)
  const [conflict, setConflict] = createSignal(false), [reading, setReading] = createSignal(false)
  const [retryable, setRetryable] = createSignal(false)
  const [refresh, setRefresh] = createSignal(0)
  const [capability, setCapability] = createSignal<"loading" | "missing" | "activatable" | "available">("loading")
  const [directory, setDirectory] = createSignal(props.draft?.scheduleDocument?.configuration.roots[0]?.directory)
  const adopt = (doc: Document) => {
    if (!directory()) setDirectory(doc.configuration.roots[0]?.directory)
    setDocument(doc); props.onLoad(doc.configuration)
    setScheduling(decodeMissionSchedulingPolicy(doc.configuration.launch, doc.configuration.roots[0]?.directory))
    setAnchorAt(Date.now()); setConflict(false); setReady(true)
  }
  createEffect(() => {
    refresh()
    const generation = getOpenCodeInstanceGeneration(props.instanceId)
    if (!props.active()) return
    const currentView = props.captureView(), controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
    const current = () => currentView() && !controller.signal.aborted
      && generation === getOpenCodeInstanceGeneration(props.instanceId)
    setCapability("loading")
    void serverApi.fetchMissionScheduleCapability(props.instanceId, props.directory, signal).then(value => {
      if (!current()) return
      if (value.location?.directory) setDirectory(value.location.directory)
      setCapability(value.api?.available ? value.enabled ? "available" : value.activation?.available ? "activatable" : "missing" : "missing")
    }).catch(() => { if (current()) setCapability("missing") })
    if (unified && target) {
      setReady(false); setFailed(false)
      void serverApi.fetchMissionSchedule(props.instanceId, target, { directory: props.directory }, signal).then(result => {
        if (!current()) return
        const doc = result.document
        if (!doc || doc.id !== target || !doc.configuration || !doc.edit) throw new Error("Mission document unavailable")
        untrack(() => {
          // A restored draft owns its revision. A refresh may reveal a conflict,
          // but only explicit Reload adopts another revision/configuration.
          if (!document()) adopt(doc)
          else {
            const changed = document()!.revision !== doc.revision
            if (!changed) setDocument(doc) // Refresh observation/locks, retaining the editable draft.
            setConflict(changed); setReady(true)
          }
        })
      }).catch(() => { if (current()) setFailed(true) })
    }
    onCleanup(() => controller.abort())
  })
  const held = () => missionScheduleEditorHold(props.scope())
  const comparison = () => {
    const { titleOverride, objective, notes, template, profiles, taskMode, watched, scheduling } = props.captureDraft()
    const { stored, ...fields } = scheduling ?? newMissionSchedulingDraft()
    return JSON.stringify({ title: titleOverride, objective, notes, template, profiles, taskMode, watched,
      scheduling: fields, storedPolicy: stored?.policy }, null, 2)
  }
  const readBody = (mission: MissionPanelMap, selector: Parameters<typeof readMissionEditorBody>[1]) => readMissionEditorBody(mission, selector,
    query => serverApi.fetchMissionContent(props.instanceId, mission.id, query, AbortSignal.timeout(10_000)))
  const readText = async (mission: MissionPanelMap) => {
    const objective = await readBody(mission, { kind: "mission", field: "objective" })
    const notes = await readBody(mission, { kind: "mission", field: "notes" })
    if (typeof objective !== "string" || notes !== undefined && typeof notes !== "string") throw new Error("Mission text unavailable")
    return { objective, notes: notes as string | undefined }
  }
  async function reload() {
    if (held() || reading() || !target || !props.active()) return
    const current = props.captureView()
    setReading(true); setFailed(false); setReady(false)
    try {
      if (!props.action.scheduleID && (!unified || document()?.kind === "one-time")) {
        const snapshot = await serverApi.fetchMission(props.instanceId, target)
        if (!current()) return
        if (!snapshot.available || !snapshot.mission || snapshot.controlUnavailable || snapshot.notificationUnavailable) throw new Error("Mission journal unavailable")
        const mission = snapshot.mission
        const text = await readText(mission)
        if (!current()) return
        if (unified) {
          const read = await serverApi.fetchMissionSchedule(props.instanceId, target, { directory: props.directory })
          if (!current()) return
          if (!read.document || read.document.configuration.objective !== text.objective
            || (read.document.configuration.notes ?? "") !== (text.notes ?? "")) throw new Error("Mission document unavailable")
          setPreviousDraft(comparison()); setJournal(mission)
          adopt(read.document)
        } else {
          setPreviousDraft(comparison()); setJournal(mission)
          props.onLoad({ ...mission, ...text, title: mission.title ?? "", taskMode: mission.taskMode ?? "native", roots: [],
            profileID: null, executionHost: null, watchedConversationIDs: [], launch: { timing: { kind: "immediate" }, condition: null,
              ends: { at: null, afterMs: null, maxLaunches: null } } })
          setConflict(false); setReady(true)
        }
        return
      }
      const result = await serverApi.fetchMissionSchedule(props.instanceId, target, { directory: props.directory })
      if (!current()) return
      if (!result.document || result.document.id !== target) throw new Error("Mission document unavailable")
      setPreviousDraft(comparison()); adopt(result.document)
    } catch { if (current()) setFailed(true) }
    finally { if (current()) setReading(false) }
  }
  async function saveJournalEdit(input: Omit<MissionJournalEditRequest, "missionID" | "expectedRevision">) {
    if (held() || !journal()) return
    const scope = props.scope(), current = props.captureView(), original = journal()!
    const request = { ...input, missionID: original.id, expectedRevision: original.revision }
    if (!holdMissionScheduleEditor(scope, request, props.captureDraft())) return
    try {
      const result = await serverApi.editMission(props.instanceId, original.id, { objective: input.objective, notes: input.notes,
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
  async function save(configuration: MissionEditorConfiguration, requestID: string) {
    if (held()) return "uncertain" as const
    const scope = props.scope(), current = props.captureView()
    // A stale editor is refused before dispatch, so explicit Reload can safely
    // retain the old draft without clearing an uncertain native mutation.
    if (unified && target) {
      const latest = await serverApi.fetchMissionSchedule(props.instanceId, target, { directory: props.directory })
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
      const result = await serverApi.saveMissionSchedule(props.instanceId, request)
      if (!exactMissionScheduleEditorReceipt(request, result)) throw new Error("Unconfirmed Mission schedule receipt")
      releaseMissionScheduleEditor(scope, requestID)
      if (current()) props.onSaved(undefined, result.document?.id)
      return "saved" as const
    } catch (error) {
      if (error instanceof HttpResponseError && (error.code === "schedule-input-invalid" || error.code === "schedule-human-required")) {
        releaseMissionScheduleEditor(scope, requestID); throw error
      }
      retainMissionScheduleEditor(scope, requestID)
      return "uncertain" as const
    }
  }
  async function reconcile() {
    const hold = held()
    if (!hold || reading() || !props.active()) return
    const current = props.captureView(), scope = props.scope()
    const request: MissionScheduleEditorRequest | MissionJournalEditRequest = JSON.parse(hold.payload)
    setReading(true); setRetryable(false)
    try {
      if (!("action" in request)) {
        const read = await serverApi.fetchMission(props.instanceId, request.missionID)
        const mission = read.available && !read.controlUnavailable && !read.notificationUnavailable ? read.mission : undefined
        const change = mission?.history.find(change => change.source === "user" && change.requestID === request.requestID
          && change.revision === request.expectedRevision + 1)
        if (!mission || !change) return
        const objective = await readBody(mission, { kind: "change", change: change.revision, field: "objective" }) as { after?: string } | undefined
        const notes = await readBody(mission, { kind: "change", change: change.revision, field: "notes" }) as { after?: string } | undefined
        if (objective?.after !== request.objective || notes?.after !== request.notes) return
        if (mission.document) {
          const text = await readText(mission)
          const state = await serverApi.fetchMissionSchedule(props.instanceId, request.missionID, { directory: props.directory })
          if (!state.document || state.document.configuration.objective !== text.objective
            || (state.document.configuration.notes ?? "") !== (text.notes ?? "")) return
        }
        releaseMissionScheduleEditor(scope, request.requestID)
        if (current()) props.onSaved(mission)
        return
      }
      const result = request.missionID
        ? await serverApi.fetchMissionSchedule(props.instanceId, request.missionID, { directory: request.directory, requestID: request.requestID })
        : await serverApi.fetchMissionScheduleCreation(props.instanceId, request.requestID, request.directory)
      if (!exactMissionScheduleEditorReceipt(request, result)) { setRetryable(partialPreparation(request, result)); return }
      releaseMissionScheduleEditor(scope, request.requestID)
      if (current()) props.onSaved(undefined, result.document?.id)
    } catch { /* Only a positive original receipt settles an unknown write. */ }
    finally { if (current()) setReading(false) }
  }
  function partialPreparation(request: MissionScheduleEditorRequest, result: MissionScheduleRead) {
    const doc = result.document, receipt = doc?.control
    return request.action === "configure" && (doc?.kind === "one-time" || doc?.dormant === true) && doc.id === request.missionID && result.pending === true
      && receipt?.action === request.action && receipt.requestID === request.requestID
      && receipt.expectedRevision === request.expectedRevision && receipt.pending === true
  }
  async function retryPreparation() {
    const hold = held()
    if (!hold || !retryable() || reading() || !props.active()) return
    const request: MissionScheduleEditorRequest | MissionJournalEditRequest = JSON.parse(hold.payload)
    if (!("action" in request) || !request.missionID) return
    const current = props.captureView(), scope = props.scope()
    setReading(true); setRetryable(false)
    try {
      const read = await serverApi.fetchMissionSchedule(props.instanceId, request.missionID, { directory: request.directory, requestID: request.requestID })
      if (!current() || held() !== hold || !partialPreparation(request, read)) return
      const result = await serverApi.saveMissionSchedule(props.instanceId, { ...request, retry: true })
      if (!exactMissionScheduleEditorReceipt(request, result)) return
      releaseMissionScheduleEditor(scope, request.requestID)
      if (current()) props.onSaved(undefined, result.document?.id)
    } catch { /* The original request remains held through any uncertain retry. */ }
    finally { if (current()) setReading(false) }
  }
  return { unified, document, journal, scheduling, setScheduling, anchorAt, previousDraft, ready, failed, conflict, reading, capability, directory,
    held, save, saveJournalEdit, reconcile, reload, retryable, retryPreparation, retryRead: () => setRefresh(value => value + 1) }
}
