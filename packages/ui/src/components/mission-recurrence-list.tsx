import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { showConfirmDialog } from "../stores/alerts"
import { MissionActionBar } from "./mission-action-bar"
import { scheduleEntryAttention, type MissionPickerEntry } from "./mission-picker-model"
import type { ActionOverflowMenuItem } from "./action-overflow-menu"
import type { MissionControlRetry, MissionPrimaryAction } from "./mission-lifecycle-controls"
import { useMissionRecurrence, type RecurrenceSchedule, type RecurrenceAction } from "../stores/mission-recurrence"
import { missionProjectView, updateMissionProjectView } from "../stores/mission-view-state"
import { showSessionChatFor } from "../stores/session-previews"
import { activeSessionId } from "../stores/sessions"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { missionScheduleText } from "./mission-schedule-text"
import { createRecurrenceControlIntent, completedRecurrenceControl, completedRecurrenceManual, partialRecurrenceControl,
  type RecurrenceControlStatus, type RecurrenceControlIntent } from "../lib/mission-recurrence-control"

// Lost replies survive remounts. Only an exact status read releases the hold.
const unresolved = new Map<string, RecurrenceControlIntent>()
const partialResults = new Map<string, RecurrenceControlStatus>()
const PRIMARY: RecurrenceAction[] = ["check", "resume", "play", "pause"]

/** Schedule controls for one row: a single contextual primary action, Stop,
 * the remaining available actions for a secondary menu, and the explicit
 * refresh-then-resend of an unconfirmed control. */
function createRecurrenceControls(props: { schedule: RecurrenceSchedule; identity: string; instanceId: string;
  directory: string; active: () => boolean; enabled: () => boolean; refresh: () => void }) {
  const { t } = useI18n()
  const key = createMemo(() => JSON.stringify([props.identity, props.schedule.id]))
  const [held, setHeld] = createSignal(unresolved.get(key()))
  const [busy, setBusy] = createSignal(false)
  const [partial, setPartial] = createSignal(partialResults.get(key()))
  const connection = createMemo(() => ({ client: instances().get(props.instanceId)?.client,
    generation: getOpenCodeInstanceGeneration(props.instanceId) }), undefined,
    { equals: (a, b) => Boolean(a && a.client === b.client && a.generation === b.generation) })
  let generation = 0
  createEffect(() => {
    const identity = key(); props.active()
    connection()
    generation++; setHeld(unresolved.get(identity)); setPartial(partialResults.get(identity)); setBusy(false)
  })
  onCleanup(() => { generation++ })
  const outstanding = () => props.schedule.controls.find(control => control.controlsComplete !== true)
  const heldIntent = () => {
    const control = outstanding()
    return held() ?? (control?.action ? { scheduleID: props.schedule.id, requestID: control.requestID,
      expectedRevision: control.expectedRevision, action: control.action, directory: props.directory } : undefined)
  }
  const capable = (action: RecurrenceAction) => props.enabled() && !busy() && !heldIntent() && !outstanding() && props.schedule.actions.includes(action)
  const retryCapable = () => {
    const intent = heldIntent(), result = partial() ?? outstanding()
    return Boolean(intent && result && partialRecurrenceControl(result, intent)) && props.enabled() && !busy()
  }
  const settle = (intent: RecurrenceControlIntent, identity: string) => {
    if (unresolved.get(identity) !== intent) return
    unresolved.delete(identity); partialResults.delete(identity); setHeld(undefined); setPartial(undefined); props.refresh()
  }
  const finish = (result: RecurrenceControlStatus, intent: RecurrenceControlIntent, identity: string) => {
    if (completedRecurrenceControl(result, intent)) settle(intent, identity)
    else if (partialRecurrenceControl(result, intent)) { partialResults.set(identity, result); setPartial(result); props.refresh() }
  }
  const act = async (action: RecurrenceAction, retry = false) => {
    if (retry ? !retryCapable() : !capable(action)) return
    const identity = key(), captured = generation, instanceId = props.instanceId
    const intent = retry ? heldIntent()! : createRecurrenceControlIntent(props.schedule.id, props.schedule.revision, action, props.directory)
    unresolved.set(identity, intent); setHeld(intent); setBusy(true)
    try {
      if (action === "run-now") {
        const result = await serverApi.runMissionRecurrenceNow(instanceId, intent)
        if (captured === generation && key() === identity && completedRecurrenceManual(result, intent)) settle(intent, identity)
      } else {
        const result = await serverApi.controlMissionRecurrence(instanceId, intent.scheduleID, { ...intent, ...(retry ? { retry: true } : {}) })
        if (captured === generation && key() === identity) finish(result, intent, identity)
      }
    } catch { /* Check status, never resend. */ }
    finally { if (captured === generation) setBusy(false) }
  }
  const check = async () => {
    const intent = heldIntent(), identity = key(), captured = generation
    if (!intent || busy() || !props.enabled()) return
    unresolved.set(identity, intent); setHeld(intent)
    setBusy(true)
    try {
      if (intent.action === "run-now") {
        const result = await serverApi.missionRecurrenceRunNowStatus(props.instanceId, intent)
        if (captured === generation && key() === identity && completedRecurrenceManual(result, intent)) settle(intent, identity)
      } else {
        const result = await serverApi.missionRecurrenceControlStatus(props.instanceId, intent.scheduleID, intent)
        if (captured === generation && key() === identity) finish(result, intent, identity)
      }
    } catch { /* Retain the exact request identity. */ }
    finally { if (captured === generation) setBusy(false) }
  }
  const stop = async () => {
    if (!capable("stop")) return
    const identity = key(), revision = props.schedule.revision, captured = generation
    const confirmed = await showConfirmDialog(t("missions.simple.confirmStop", { title: props.schedule.title }), { variant: "warning",
      confirmLabel: t("missions.simple.stop"), cancelLabel: t("missions.simple.cancel") })
    // The confirmation described this exact schedule revision.
    if (confirmed && captured === generation && key() === identity && props.schedule.revision === revision) await act("stop")
  }
  // "check" reconciles a paused pending passage; its label differs from the control-outcome status check.
  const label = (action: RecurrenceAction) => t(action === "check" ? "missionsPanel.action.checkPassage" : action === "run-now"
    ? "missionsPanel.action.runNow" : action === "play" ? "missionsPanel.action.start" : action === "stop" ? "missionsPanel.action.stop"
    : `missionsPanel.action.${action}`)
  const description = (action: RecurrenceAction) => t(action === "check" ? "missions.recurrence.checkPassage" : `missions.recurrence.${action}`, { id: props.schedule.title })
  const primaryAction = () => heldIntent() ? undefined : PRIMARY.find(action => props.schedule.actions.includes(action))
  const primary = (): MissionPrimaryAction | undefined => {
    if (heldIntent()) return { key: "status", label: t("missionsPanel.action.checkStatus"), ariaLabel: t("missions.recurrence.check", { id: props.schedule.title }), disabled: busy() || !props.enabled(), onSelect: check }
    const action = primaryAction()
    return action ? { key: action, label: label(action), ariaLabel: description(action), disabled: !capable(action), onSelect: () => act(action) } : undefined
  }
  const stopAction = (): MissionPrimaryAction | undefined => props.schedule.actions.includes("stop") && !heldIntent()
    ? { key: "stop", label: label("stop"), ariaLabel: description("stop"), disabled: !capable("stop"), onSelect: stop } : undefined
  // The panel refresh first reads the exact request's status, then resends it
  // only when that read leaves it partially applied.
  const retry: MissionControlRetry = { pending: () => Boolean(heldIntent()) && props.enabled(),
    reconcile: () => heldIntent() ? check() : Promise.resolve(),
    resend: () => retryCapable() ? act(heldIntent()!.action, true) : Promise.resolve() }
  const menu = (): ActionOverflowMenuItem[] => [
    ...props.schedule.actions.filter(action => action !== primaryAction() && action !== "stop" && !heldIntent()).map(action => ({
      key: action, label: label(action), description: description(action), disabled: !capable(action),
      onSelect: () => action === "stop" ? stop() : act(action),
    })),
  ]
  const feedback = <Show when={heldIntent()}><small role="status">{t("missions.recurrence.uncertain")}</small></Show>
  return { primary, stop: stopAction, menu, retry, feedback }
}

/** Recurring schedules: picker entries for the shared mission list, and the
 * selected schedule's detail (actions, notice, current passage, past runs). */
export function createMissionRecurrenceList(props: { instanceId: string; projectID?: string; scope: string; active: () => boolean; refresh: number;
  selectedSchedule?: string; onRead?: (restoreChat?: boolean) => void; detailId: string
  tracking?: JSX.Element
  /** The admitted passage, when one is tracked: its overview reader and coordinator conversation. */
  passage?: { reading: boolean; onToggle: () => void; onOpenConversation: () => void }
  registerRetry?: (retry: MissionControlRetry) => () => void }) {
  const { t, locale } = useI18n()
  const [revision, setRevision] = createSignal(0)
  const { snapshot, error, loading } = useMissionRecurrence({ instanceId: () => props.instanceId,
    projectID: () => props.projectID, directory: () => props.scope, refresh: () => props.refresh + revision(), active: props.active })
  const valid = () => !loading() && !error() && props.active() && snapshot()?.projectID === props.projectID && Boolean(props.projectID)
  const text = missionScheduleText(t, locale)
  const { date } = text
  /** One sentence; its action is the row's primary control (Check passage or Resume). */
  const notice = (schedule: RecurrenceSchedule) => {
    if (schedule.pending?.status === "uncertain") return schedule.pending.reason === "admission-failing" ? "missions.recurrence.pending.retrying"
      : schedule.actions.includes("check") ? "missions.recurrence.pending.checkNeeded"
      : schedule.interruptionReason === "service-restart" ? "missions.simple.restart" : "missions.simple.resumeExplanation"
    if (schedule.state !== "interrupted") return undefined
    return schedule.interruptionReason === "service-restart" ? "missions.simple.restart"
      : schedule.interruptionReason === "error" ? "missions.recurrence.interruptedError" : "missions.simple.resumeExplanation"
  }
  const reading = (id: string, passageID?: string) => {
    const reader = missionProjectView(props.scope).reader
    return reader?.kind === "recurrence" && reader.missionId === id && reader.instanceId === props.instanceId
      && reader.projectID === props.projectID && reader.itemId === passageID
  }
  const read = (id: string, passageID?: string) => {
    const wasReading = reading(id, passageID)
    showSessionChatFor(activeSessionId().get(props.instanceId) ?? "", props.scope)
    updateMissionProjectView(props.scope, { reader: wasReading ? undefined : { kind: "recurrence", missionId: id,
      instanceId: props.instanceId, projectID: props.projectID, ...(passageID ? { itemId: passageID } : {}) } })
    if (!wasReading) props.onRead?.()
  }
  const pastRuns = (schedule: RecurrenceSchedule) => <Show when={schedule.history.length}
    fallback={<p class="mission-control-empty-line">{t("missionsPanel.schedule.noRuns")}</p>}>
    <section class="mission-past-runs" aria-label={t("missionsPanel.pastRuns")}>
      <ol><For each={[...schedule.history].reverse()}>{item => <li>
        <button type="button" class="mission-past-run icon-toggle" aria-pressed={reading(schedule.id, item.passageID)}
          onClick={() => read(schedule.id, item.passageID)}>
          <bdi>{text.run(schedule, item)}</bdi>
        </button></li>}</For></ol>
    </section></Show>
  const entries = createMemo((): MissionPickerEntry[] => (snapshot()?.schedules ?? []).map(schedule => {
    const attention = scheduleEntryAttention(schedule)
    const state = t(`missions.recurrence.state.${schedule.state}`), next = text.next(schedule)
    return { key: `schedule:${schedule.id}`, title: schedule.title, attention, mark: attention ?? schedule.state,
      status: [t("missionsPanel.dailyBadge"), state, next, text.every(schedule)].filter(Boolean).join(" · ") }
  }))
  const selectedId = () => snapshot()?.schedules.some(schedule => schedule.id === props.selectedSchedule) ? props.selectedSchedule : undefined
  const view = () => <>
    <Show when={error()}><p role="status">{t(snapshot() ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
    {/* Separate detail below the list: actions, a stuck schedule's one sentence,
        the current passage's tree and the compact list of past runs. */}
    <Show when={selectedId()} keyed>{id => {
      // Keyed by identity: a refreshed snapshot keeps the controls and their focus.
      const schedule = createMemo<RecurrenceSchedule>(previous => snapshot()?.schedules.find(item => item.id === id) ?? previous!)
      const controls = createRecurrenceControls({ get schedule() { return schedule() }, get identity() { return JSON.stringify([props.instanceId, props.projectID, props.scope]) },
        get instanceId() { return props.instanceId }, get directory() { return props.scope }, active: props.active, enabled: valid,
        refresh: () => setRevision(value => value + 1) })
      const unregister = props.registerRetry?.(controls.retry)
      onCleanup(() => unregister?.())
      return <section id={props.detailId} class="mission-detail mission-schedule-detail" aria-label={schedule().title}>
        {/* A running passage's summary opens what is happening now; otherwise the schedule reader. */}
        <MissionActionBar label={t("missionsPanel.picker.actions")}
          reading={props.passage ? props.passage.reading : reading(schedule().id)}
          onToggleReader={() => props.passage ? props.passage.onToggle() : read(schedule().id)}
          primary={controls.primary()} stop={controls.stop()} onOpenConversation={props.passage?.onOpenConversation}
          items={controls.menu()} feedback={controls.feedback} />
        <Show when={notice(schedule())}>{key => <p class="mission-schedule-notice" role="status">{t(key())}</p>}</Show>
        <Show when={schedule().lastError}>{failure => <p class="mission-control-stale" role="status">
          {t("missions.recurrence.lastError", { time: date(schedule(), failure().at) })}</p>}</Show>
        {props.tracking}
        {pastRuns(schedule())}
      </section>
    }}</Show>
  </>
  return { entries, view }
}
