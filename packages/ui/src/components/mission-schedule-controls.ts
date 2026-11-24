import { batch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { generateUUID } from "../lib/client-identity"
import { unifiedScheduleHolds as holds, unifiedScheduleHold, changedUnifiedScheduleHolds as bump,
  type UnifiedMissionSchedule, type UnifiedScheduleAction as Action, type UnifiedScheduleHold as Hold } from "../stores/mission-schedules"
import { backendOf } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { useI18n } from "../lib/i18n"
import { showConfirmDialog } from "../stores/alerts"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { instances } from "../stores/instances"
import { requiresMissionCalendar } from "../../../server/src/missions/mission-launch-kind"
import { partialMissionScheduleReceipt as partialReceipt, refusedMissionScheduleReceipt, type MissionScheduleControlReceipt as ControlReceipt } from "../lib/mission-schedule-receipt"
import type { MissionScheduleCapability } from "../../../server/src/api-types"
import { HttpResponseError } from "../lib/retryable-file-search"

type ActivationRefusal = Extract<MissionScheduleCapability["activation"], { available: false }>["refusal"]

// Exact dispatched identities survive navigation and remount. Unresolved entries
// never evict; the ceiling refuses another control rather than forgetting one.
export function exactMissionScheduleControl(result: ControlReceipt, hold: Hold, id: string) {
  if (hold.phase !== "control" || result.pending) return false
  if (hold.action === "delete") return !!("deleted" in result && result.deleted && result.deletionReceipt?.id === id
    && result.deletionReceipt.requestID === hold.requestID && result.deletionReceipt.expectedRevision === hold.expectedRevision
    && result.deletionReceipt.deleteManagedSessions === false)
  const receipt = result.document?.control
  return result.document?.id === id && receipt?.requestID === hold.requestID && receipt.expectedRevision === hold.expectedRevision
    && receipt.action === hold.action && receipt.pending === false
}

export function createMissionScheduleControls(props: { instanceId: string; projectID?: string; directory: string;
  document: () => UnifiedMissionSchedule; active: () => boolean; enabled: () => boolean; refreshVersion: () => number;
  refresh: () => void; onDeleted: () => void; captureOperation?: () => (() => boolean) }) {
  const { t } = useI18n()
  const identity = () => JSON.stringify([props.instanceId, props.projectID, props.directory, props.document().id])
  const [busy, setBusy] = createSignal(false), [feedback, setFeedback] = createSignal<string>()
  const [pendingAction, setPendingAction] = createSignal<Action>()
  const [refusal, setRefusal] = createSignal<ActivationRefusal>()
  let alive = true
  onCleanup(() => { alive = false })
  const held = () => unifiedScheduleHold(identity())
  const publishing = () => held()?.phase === "publication"
  const [capability, setCapability] = createSignal<"loading" | "available" | "activatable" | "missing">("loading")
  const capabilityOwner = createMemo(() => ({ key: identity(), active: props.active(),
    signal: captureBackendOperation(props.instanceId).signal,
    client: instances().get(props.instanceId)?.client, generation: getOpenCodeInstanceGeneration(props.instanceId) }), undefined,
    { equals: (a, b) => !!a && a.signal === b.signal && a.key === b.key && a.active === b.active && a.client === b.client && a.generation === b.generation })
  const capture = () => {
    const owner = capabilityOwner()
    const operation = captureBackendOperation(props.instanceId)
    const parent = props.captureOperation?.() ?? (() => true)
    return () => operation.current() && alive && props.active() && capabilityOwner() === owner && parent()
  }
  let previousOwner: ReturnType<typeof capabilityOwner> | undefined
  createEffect(() => {
    const owner = capabilityOwner(); props.refreshVersion()
    untrack(() => {
      if (owner !== previousOwner) { setBusy(false); setPendingAction(undefined); setRefusal(undefined); setFeedback(undefined); setCapability("loading"); previousOwner = owner }
      if (!props.active()) return
      const currentView = capture(), abort = new AbortController()
      const current = () => currentView() && !abort.signal.aborted
      void backendOf(props.instanceId).api.fetchMissionScheduleCapability(props.instanceId, props.directory, AbortSignal.any([owner.signal, abort.signal])).then(value => {
        if (current()) {
          setCapability(value.api.available ? value.enabled ? "available" : value.activation.available ? "activatable" : "missing" : "missing")
          setRefusal(value.api.available && !value.activation.available ? value.activation.refusal : undefined)
          if (value.activation.available && feedback() === "missions.scheduleList.activationRefused") setFeedback(undefined)
        }
      }).catch(() => { if (current()) setCapability("missing") })
      onCleanup(() => abort.abort())
    })
  })
  const settle = (key: string, hold: Hold, current: () => boolean, revision?: number) => {
    if (holds.get(key) !== hold) return
    // The hold can be the selected row's sole display owner. Schedule its parent's
    // fresh read and deletion callback before publication disposes this controller.
    batch(() => {
      if (revision !== undefined) holds.set(key, { ...hold, phase: "publication", minimumRevision: Math.max(hold.minimumRevision ?? 0, revision) })
      else holds.delete(key)
      if (current()) { props.refresh(); if (revision === undefined && hold.action === "delete") props.onDeleted() }
      bump()
    })
  }
  const capable = (action: Action, creation = false) => props.active() && props.enabled() && !busy() && props.document().availableActions.includes(action)
     && (held()?.minimumRevision === undefined || props.document().revision >= held()!.minimumRevision!)
     && (!requiresMissionCalendar(props.document().configuration.launch) || !["play", "resume", "run-now"].includes(action)
        || creation && action === "play" || capability() === "available" || action !== "run-now" && capability() === "activatable")
    && !held()
  async function receipt(key: string, hold: Hold, current: () => boolean) {
    if (!current()) return
    const doc = props.document(), result = await backendOf(props.instanceId).api.fetchMissionSchedule(props.instanceId, doc.id,
      { directory: props.directory, requestID: hold.requestID }, AbortSignal.timeout(30_000)).catch(error => {
        const result = partialReceipt(error); if (result) return result; throw error
      })
    // A dispatched intent owns its exact receipt independently of the view.
    // Only further reads and view publication require the live operation.
    if (exactMissionScheduleControl(result, hold, doc.id)) {
      if (holds.get(key) !== hold) return
      const revision = result.document?.revision
      if (hold.action !== "delete" && (!Number.isSafeInteger(revision) || revision! < hold.expectedRevision)) return
      settle(key, hold, current, hold.action === "delete" ? undefined : revision)
    }
    else if (holds.get(key) === hold) {
      const control = result.document?.control
      hold.partial = !!(result.document?.id === doc.id && control?.requestID === hold.requestID
        && control.expectedRevision === hold.expectedRevision && control.action === hold.action && typeof control.pending === "boolean" && result.pending)
      bump()
    }
  }
  async function reconcile() {
    const hold = held(), key = identity(), current = capture()
    if (!current() || !hold || busy() || !props.active()) return
    setBusy(true)
    try {
      if (hold.phase === "publication") { if (current()) props.refresh(); return }
      if (hold.phase === "activation") {
        const { document } = await backendOf(props.instanceId).api.missionScheduleSettings(props.instanceId, props.document().id,
          { requestID: hold.requestID, expectedDocumentRevision: hold.expectedRevision })
        const proof = document.scheduleActivation
        if (Number.isSafeInteger(document.revision) && document.revision >= hold.expectedRevision
          && proof?.requestID === hold.requestID && proof.expectedRevision === hold.expectedRevision && proof.state === "ready") settle(key, hold, current, document.revision)
      } else await receipt(key, hold, current)
      if (current()) props.refresh()
    } catch { /* Negative or failed reads preserve the original identity. */ }
    finally { if (current()) setBusy(false) }
  }
  async function act(action: Action, creation = false) {
    if (!capable(action, creation)) return
    const current = capture(), key = identity(), original = props.document()
    if (!current()) return
    setBusy(true); setPendingAction(action); setFeedback(undefined); setRefusal(undefined)
    let dispatched: Hold | undefined
    try {
      // The button/confirmation describes an exact revision, not a live draft.
      const latest = await backendOf(props.instanceId).api.fetchMissionSchedule(props.instanceId, original.id, { directory: props.directory }, AbortSignal.timeout(30_000))
      if (!current()) return
      if (!latest.document || latest.document.id !== original.id || latest.document.revision !== original.revision) {
        setFeedback("missions.scheduleList.conflict"); props.refresh(); return
      }
      if (action === "stop" || action === "delete" || action === "run-now") {
        setPendingAction(undefined)
        const confirmed = await showConfirmDialog(t(`missions.scheduleList.confirm.${action}`, { title: original.configuration.title }),
          { variant: "warning", confirmLabel: label(action), cancelLabel: t("missions.simple.cancel") })
        if (!confirmed || !current() || props.document().revision !== original.revision) return
        setPendingAction(action)
      }
      let revision = original.revision
      if (["play", "resume", "run-now"].includes(action) && requiresMissionCalendar(original.configuration.launch)) {
        const capability = await backendOf(props.instanceId).api.fetchMissionScheduleCapability(props.instanceId, props.directory, AbortSignal.timeout(30_000))
        if (!current()) return
        if (!capability.activation.available && capability.activation.refusal) {
          setRefusal(capability.activation.refusal); setFeedback("missions.scheduleList.activationRefused"); return
        }
        if (!capability.api.available || !capability.enabled && !capability.activation.available) {
          setFeedback("missions.scheduling.capability.missing"); return
        }
        if (action === "run-now" && !capability.enabled) {
          setFeedback("missions.scheduleList.runNowRequiresEnabled"); return
        }
        if (action !== "run-now" && (!capability.enabled || latest.document.scheduleActivation?.state !== "ready")) {
          if (holds.size >= 128 && !holds.has(key)) { setFeedback("missions.scheduleList.capacity"); return }
          // An ON display alone cannot replace the server's ready proof.
          // A retained proof keeps its original identity on the server.
          const previous = latest.document.scheduleActivation
          const activation: Hold = { phase: "activation", action, requestID: previous?.state === "ready" ? previous.requestID : generateUUID(),
            expectedRevision: previous?.state === "ready" ? previous.expectedRevision : revision, partial: false, document: original }
          holds.set(key, activation); dispatched = activation; bump()
          const value = await backendOf(props.instanceId).api.missionScheduleSettings(props.instanceId, original.id,
            { requestID: activation.requestID, expectedDocumentRevision: revision }, true)
          const proof = value.document.scheduleActivation
          if (!Number.isSafeInteger(value.document.revision) || value.document.revision < revision
            || proof?.requestID !== activation.requestID || proof.expectedRevision !== activation.expectedRevision || proof.state !== "ready") return
          settle(key, activation, current, value.document.revision); dispatched = undefined
          if (!current()) return
          revision = value.document.revision
        }
      }
      if (!current() || holds.size >= 128 && !holds.has(key)) return
      const request: Hold = { phase: "control", action, requestID: generateUUID(), expectedRevision: revision, partial: false,
        document: original, minimumRevision: holds.get(key)?.minimumRevision }
      holds.set(key, request); bump()
      dispatched = request
      const result = await backendOf(props.instanceId).api.controlMissionSchedule(props.instanceId, original.id, { action, requestID: request.requestID,
        expectedRevision: revision, directory: props.directory, ...(action === "delete" ? { deleteManagedSessions: false } : {}) }).catch(error => {
          const result = partialReceipt(error); if (result) return result; throw error
        })
      if (exactMissionScheduleControl(result, request, original.id)
        && (action === "delete" || Number.isSafeInteger(result.document?.revision) && result.document!.revision! >= revision))
        settle(key, request, current, action === "delete" ? undefined : result.document?.revision)
      else if (current()) await receipt(key, request, current)
      if (current()) props.refresh()
    } catch (error) {
      if (error instanceof HttpResponseError && error.code === "schedule-activation-refused") {
        const body = error.body as { refusal?: ActivationRefusal; notApplied?: { requestID?: string; expectedRevision?: number } } | undefined
        if (dispatched?.phase === "activation" && holds.get(key) === dispatched
          && body?.notApplied?.requestID === dispatched.requestID && body.notApplied.expectedRevision === dispatched.expectedRevision) {
          holds.delete(key); bump()
        }
        if (current()) { setRefusal(body?.refusal); setFeedback("missions.scheduleList.activationRefused") }
        // Without exact no-effect proof, preserve the original activation.
      } else if (dispatched?.phase === "activation" && error instanceof HttpResponseError
        && ["schedule-activation-conflict", "schedule-activation-unavailable"].includes(error.code ?? "") && holds.get(key) === dispatched) {
        holds.delete(key); bump()
        if (current()) setFeedback("missions.scheduleList.conflict")
      } else if (dispatched?.phase === "control" && refusedMissionScheduleReceipt(error, dispatched, original.id) && holds.get(key) === dispatched) {
        if (dispatched.minimumRevision !== undefined) settle(key, dispatched, current, dispatched.minimumRevision)
        else { holds.delete(key); bump(); if (current()) props.refresh() }
        if (current()) setFeedback("missions.scheduleList.conflict")
      } else if (current() && !dispatched) setFeedback("missions.scheduleList.readFailed")
    }
    finally { if (current()) { setBusy(false); setPendingAction(undefined); props.refresh() } }
  }
  const label = (action: Action) => t(action === "delete" ? "missionsPanel.picker.delete" : action === "run-now" ? "missionsPanel.action.runNow"
    : action === "play" ? "missionsPanel.action.start" : `missionsPanel.action.${action}`)
  // Direct creation already has an exact document receipt. Its continuation still
  // rereads the document and capability before any activation or Play dispatch.
  const progress = () => pendingAction() ? pendingAction() === "play" ? "missionsPanel.action.starting"
    : pendingAction() === "resume" ? "missionsPanel.action.resuming" : pendingAction() === "run-now" ? "missionsPanel.action.runningNow"
      : "missions.control.mutation.pending" : undefined
  return { held, publishing, busy, pendingAction, progress, feedback, refusal, capability, capable, act, reconcile, label,
    startCreated: () => act("play", true) }
}
