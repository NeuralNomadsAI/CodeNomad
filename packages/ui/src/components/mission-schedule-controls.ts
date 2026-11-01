import { batch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { unifiedScheduleHolds as holds, unifiedScheduleHold, changedUnifiedScheduleHolds as bump,
  type UnifiedMissionSchedule, type UnifiedScheduleAction as Action, type UnifiedScheduleHold as Hold } from "../stores/mission-schedules"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { showConfirmDialog } from "../stores/alerts"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { instances } from "../stores/instances"
import { requiresMissionCalendar } from "../../../server/src/missions/mission-launch-kind"
import { partialMissionScheduleReceipt as partialReceipt, type MissionScheduleControlReceipt as ControlReceipt } from "../lib/mission-schedule-receipt"

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
  refresh: () => void; onDeleted: () => void }) {
  const { t } = useI18n()
  const identity = () => JSON.stringify([props.instanceId, props.projectID, props.directory, props.document().id])
  const [busy, setBusy] = createSignal(false), [feedback, setFeedback] = createSignal<string>()
  let alive = true
  onCleanup(() => { alive = false })
  const held = () => unifiedScheduleHold(identity())
  const [capability, setCapability] = createSignal<"loading" | "available" | "activatable" | "missing">("loading")
  const capabilityOwner = createMemo(() => ({ key: identity(), active: props.active(),
    client: instances().get(props.instanceId)?.client, generation: getOpenCodeInstanceGeneration(props.instanceId) }), undefined,
    { equals: (a, b) => !!a && a.key === b.key && a.active === b.active && a.client === b.client && a.generation === b.generation })
  const capture = () => {
    const owner = capabilityOwner()
    return () => alive && props.active() && capabilityOwner() === owner
  }
  let previousOwner: ReturnType<typeof capabilityOwner> | undefined
  createEffect(() => {
    const owner = capabilityOwner(); props.refreshVersion()
    untrack(() => {
      if (owner !== previousOwner) { setBusy(false); setCapability("loading"); previousOwner = owner }
      if (!props.active()) return
      const currentView = capture(), abort = new AbortController()
      const current = () => currentView() && !abort.signal.aborted
      void serverApi.fetchMissionScheduleCapability(props.instanceId, props.directory, abort.signal).then(value => {
        if (current()) setCapability(value.api.available ? value.enabled ? "available" : value.activation.available ? "activatable" : "missing" : "missing")
      }).catch(() => { if (current()) setCapability("missing") })
      onCleanup(() => abort.abort())
    })
  })
  const settle = (key: string, hold: Hold, current: () => boolean) => {
    if (holds.get(key) !== hold) return
    // The hold can be the selected row's sole display owner. Schedule its parent's
    // fresh read and deletion callback before publication disposes this controller.
    batch(() => {
      holds.delete(key)
      if (current()) { props.refresh(); if (hold.action === "delete") props.onDeleted() }
      bump()
    })
  }
  const capable = (action: Action) => props.active() && props.enabled() && !busy() && props.document().availableActions.includes(action)
     && (!requiresMissionCalendar(props.document().configuration.launch) || !["play", "resume", "run-now"].includes(action)
       || capability() === "available" || action !== "run-now" && capability() === "activatable")
    && (!held() || action === "check" && held()!.phase === "control" && held()!.partial && !held()!.original)
  async function receipt(key: string, hold: Hold, current: () => boolean) {
    const doc = props.document(), result = await serverApi.fetchMissionSchedule(props.instanceId, doc.id,
      { directory: props.directory, requestID: hold.requestID }).catch(error => {
        const result = partialReceipt(error); if (result) return result; throw error
      })
    if (exactMissionScheduleControl(result, hold, doc.id)) {
      if (holds.get(key) !== hold) return
      if (hold.original) { holds.set(key, hold.original); bump(); if (current()) await receipt(key, hold.original, current) }
      else settle(key, hold, current)
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
    if (!hold || busy() || !props.active()) return
    setBusy(true)
    try {
      if (hold.phase === "activation") {
        const { document } = await serverApi.missionScheduleSettings(props.instanceId, props.document().id,
          { requestID: hold.requestID, expectedDocumentRevision: hold.expectedRevision })
        const proof = document.scheduleActivation
        if (proof?.requestID === hold.requestID && proof.expectedRevision === hold.expectedRevision && proof.state === "ready") settle(key, hold, current)
      } else await receipt(key, hold, current)
      if (current()) props.refresh()
    } catch { /* Negative or failed reads preserve the original identity. */ }
    finally { if (current()) setBusy(false) }
  }
  async function act(action: Action) {
    if (!capable(action)) return
    const current = capture(), key = identity(), original = props.document(), previous = held()
    setBusy(true); setFeedback(undefined)
    let dispatched: Hold | undefined
    try {
      // The button/confirmation describes an exact revision, not a live draft.
      const latest = await serverApi.fetchMissionSchedule(props.instanceId, original.id, { directory: props.directory })
      if (!current()) return
      if (!latest.document || latest.document.revision !== original.revision) {
        setFeedback("missions.scheduleList.conflict"); props.refresh(); return
      }
      if (action === "stop" || action === "delete" || action === "run-now") {
        const confirmed = await showConfirmDialog(t(`missions.scheduleList.confirm.${action}`, { title: original.configuration.title }),
          { variant: "warning", confirmLabel: label(action), cancelLabel: t("missions.simple.cancel") })
        if (!confirmed || !current() || props.document().revision !== original.revision) return
      }
      let revision = original.revision
      if (["play", "resume", "run-now"].includes(action) && requiresMissionCalendar(original.configuration.launch)) {
        const capability = await serverApi.fetchMissionScheduleCapability(props.instanceId, props.directory)
        if (!current()) return
        if (!capability.api.available || !capability.enabled && !capability.activation.available) {
          setFeedback("missions.scheduling.capability.missing"); return
        }
        if (action === "run-now" && !capability.enabled) {
          setFeedback("missions.scheduleList.runNowRequiresEnabled"); return
        }
        if (!capability.enabled) {
          const targets = capability.activation.targets.map(item => item.path).join("\n")
          const confirmed = await showConfirmDialog(t("missions.scheduleList.activate", { paths: targets }),
            { variant: "warning", confirmLabel: label(action), cancelLabel: t("missions.simple.cancel") })
          if (!confirmed || !current() || props.document().revision !== original.revision) return
          if (holds.size >= 128 && !holds.has(key)) { setFeedback("missions.scheduleList.capacity"); return }
          const activation: Hold = { phase: "activation", action, requestID: crypto.randomUUID(), expectedRevision: revision, partial: false, document: original }
          holds.set(key, activation); dispatched = activation; bump()
          const value = await serverApi.missionScheduleSettings(props.instanceId, original.id,
            { requestID: activation.requestID, expectedDocumentRevision: revision }, true)
          const proof = value.document.scheduleActivation
          if (proof?.requestID !== activation.requestID || proof.expectedRevision !== revision || proof.state !== "ready") return
          settle(key, activation, current); dispatched = undefined
          if (!current()) return
          revision = value.document.revision
        }
      }
      if (!current() || holds.size >= 128 && !holds.has(key)) return
      const request: Hold = { phase: "control", action, requestID: crypto.randomUUID(), expectedRevision: revision, partial: false,
        document: original, ...(previous ? { original: previous } : {}) }
      // Check is the sole permitted successor of a positively read partial intent.
      // It reconciles that original; its own ACK cannot release the original hold.
      holds.set(key, request); bump()
      dispatched = request
      const result = await serverApi.controlMissionSchedule(props.instanceId, original.id, { action, requestID: request.requestID,
        expectedRevision: revision, directory: props.directory, ...(action === "delete" ? { deleteManagedSessions: false } : {}) }).catch(error => {
          const result = partialReceipt(error); if (result) return result; throw error
        })
      if (!previous && exactMissionScheduleControl(result, request, original.id)) settle(key, request, current)
      else if (current()) await receipt(key, request, current)
      if (current()) props.refresh()
    } catch { if (current() && !dispatched) setFeedback("missions.scheduleList.readFailed") }
    finally { if (current()) { setBusy(false); props.refresh() } }
  }
  const label = (action: Action) => t(action === "delete" ? "missionsPanel.picker.delete" : action === "run-now" ? "missionsPanel.action.runNow"
    : action === "check" ? "missionsPanel.action.checkPassage" : action === "play" ? "missionsPanel.action.start" : `missionsPanel.action.${action}`)
  return { held, busy, feedback, capability, capable, act, reconcile, label }
}
