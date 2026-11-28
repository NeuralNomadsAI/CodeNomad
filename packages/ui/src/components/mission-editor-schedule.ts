import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import { backendOf } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { MissionMutationError } from "../lib/mission-mutation"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { instances } from "../stores/instances"
import type { MissionEditorAction, MissionEditorDraft } from "../stores/mission-editor-state"
import { holdMissionScheduleEditor, missionScheduleEditorHold, releaseMissionScheduleEditor, retainMissionScheduleEditor,
  type MissionJournalEditRequest } from "../stores/mission-schedule-editor-holds"
import { newMissionSchedulingDraft } from "./mission-scheduling-data"
import { readMissionEditorBody } from "./mission-editor-body"
import { rereadMissionHoldWhileActive } from "../lib/mission-held-reread"

/** What an edit loads again from its Mission. */
export type MissionEditorLoaded = { title: string; objective: string; notes?: string; template: MissionPanelMap["template"]; profiles?: MissionProfiles
  taskMode: "native" | "independent"; coordinatorGoal?: boolean }
/** The form's launch criteria, and the edit of a started Mission's objective and notes. */
export function createMissionEditorScheduling(props: {
  instanceId: string; action: MissionEditorAction; draft?: Readonly<MissionEditorDraft>
  /** Scalar view identity; with the client and native generation, it owns the shown reads. */
  scope: () => string; owner: () => string; active: () => boolean; captureView: () => (() => boolean)
  onLoad: (loaded: MissionEditorLoaded) => void
  captureDraft: () => MissionEditorDraft; onSaved: (mission?: MissionPanelMap) => void
}) {
  const target = props.action.mission?.id
  const [journal, setJournal] = createSignal(props.draft?.journalMission ?? props.action.mission)
  const [scheduling, setScheduling] = createSignal(props.draft?.scheduling ?? newMissionSchedulingDraft())
  const [previousDraft, setPreviousDraft] = createSignal(props.draft?.previousDraft)
  const [ready, setReady] = createSignal(true), [failed, setFailed] = createSignal(false)
  const [conflict, setConflict] = createSignal(false), [reading, setReading] = createSignal(false)
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
  let reconcileRead: AbortController | undefined
  const stopReconcile = () => { reconcileRead?.abort(); reconcileRead = undefined }
  let previousOwner: ReturnType<typeof owner> | undefined
  const visible = createMemo(() => props.active())
  createEffect(() => {
    const value = owner(), active = visible()
    untrack(() => {
      const changed = Boolean(previousOwner && value !== previousOwner)
      previousOwner = value
      stopReconcile()
      if (active && changed && held()?.state === "uncertain") void reconcile()
    })
  })
  onCleanup(stopReconcile)
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
      const snapshot = await backendOf(props.instanceId).api.fetchMission(props.instanceId, target)
      if (!current()) return
      if (!snapshot.available || !snapshot.mission || snapshot.controlUnavailable || snapshot.notificationUnavailable) throw new Error("Mission journal unavailable")
      const mission = snapshot.mission, text = await readText(mission, current)
      if (!current()) return
      setPreviousDraft(comparison()); setJournal(mission)
      props.onLoad({ title: mission.title ?? "", ...text, template: mission.template, profiles: mission.profiles, taskMode: mission.taskMode ?? "native", coordinatorGoal: mission.coordinatorGoal })
      setConflict(false); setReady(true)
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
  async function reconcile() {
    const hold = held()
    if (!hold || hold.state !== "uncertain" || reading() || reconcileRead || !props.active()) return
    const viewCurrent = capture(), scope = props.scope(), readOwner = owner()
    if (!viewCurrent()) return
    const controller = reconcileRead = new AbortController()
    const owned = captureOwner(controller)
    const signal = AbortSignal.any([readOwner.signal, controller.signal, AbortSignal.timeout(30_000)])
    const current = () => viewCurrent() && owned() && reconcileRead === controller && !signal.aborted
    const request: MissionJournalEditRequest = JSON.parse(hold.payload)
    try {
      const read = await backendOf(props.instanceId).api.fetchMission(props.instanceId, request.missionID, signal)
      if (!current()) return
      const mission = read.available && !read.controlUnavailable && !read.notificationUnavailable ? read.mission : undefined
      const change = mission?.history.find(change => change.source === "user" && change.requestID === request.requestID
        && change.revision === request.expectedRevision + 1)
      if (!mission || !change) return
      const objective = await readBody(mission, { kind: "change", change: change.revision, field: "objective" }, current, signal) as { after?: string } | undefined
      const notes = await readBody(mission, { kind: "change", change: change.revision, field: "notes" }, current, signal) as { after?: string } | undefined
      if (objective?.after !== request.objective || notes?.after !== request.notes) return
      releaseMissionScheduleEditor(scope, request.requestID)
      if (current()) props.onSaved(mission)
    } catch { /* Only a positive original receipt settles an unknown write. */ }
    finally { if (reconcileRead === controller) reconcileRead = undefined }
  }
  rereadMissionHoldWhileActive(() => held()?.state === "uncertain", props.active, reconcile)
  return { journal, scheduling, setScheduling, previousDraft, ready, failed, conflict, reading, held, saveJournalEdit, reconcile, reload }
}
