import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { showConfirmDialog } from "../stores/alerts"
import { MissionActionBar } from "./mission-action-bar"
import { scheduleEntryAttention, type MissionPickerEntry } from "./mission-picker-model"
import type { MissionControlRetry, MissionPrimaryAction } from "./mission-lifecycle-controls"
import { useMissionRecurrence, type RecurrenceSchedule, type RecurrenceAction } from "../stores/mission-recurrence"
import { missionProjectView, updateMissionProjectView } from "../stores/mission-view-state"
import { showSessionChatFor } from "../stores/session-previews"
import { activeSessionId } from "../stores/sessions"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { missionScheduleText } from "./mission-schedule-text"
import { createRecurrenceControlIntent, completedRecurrenceControl, completedRecurrenceManual, partialRecurrenceControl,
  recurrenceControlRefusalKey, rejectedRecurrenceControl, type RecurrenceControlStatus, type RecurrenceControlIntent } from "../lib/mission-recurrence-control"

// Lost replies survive remounts. Only an exact status read releases the hold.
const unresolved = new Map<string, RecurrenceControlIntent>()
const partialResults = new Map<string, RecurrenceControlStatus>()
// Bumped on each exact release, so every mounted control drops that request
// even when the release lands after its context changed.
const [releases, setReleases] = createSignal(0)
const sameIntent = (a: RecurrenceControlIntent, b: RecurrenceControlIntent) => a.scheduleID === b.scheduleID && a.requestID === b.requestID
  && a.expectedRevision === b.expectedRevision && a.action === b.action && a.directory === b.directory
const PRIMARY: RecurrenceAction[] = ["check", "resume", "play", "pause"]
const START_INTENTS: RecurrenceAction[] = ["play", "resume", "check", "run-now"]
const SUPERSEDING: RecurrenceAction[] = ["resume", "pause", "stop", "check"]

/** Schedule controls for one row: a single contextual primary action, Stop,
 * the remaining available actions for a secondary menu, and the explicit
 * refresh-then-resend of an unconfirmed control. */
function createRecurrenceControls(props: { schedule: RecurrenceSchedule; identity: string; instanceId: string;
  directory: string; active: () => boolean; enabled: () => boolean; retryEnabled: () => boolean; refresh: () => void }) {
  const { t } = useI18n()
  const key = createMemo(() => JSON.stringify([props.identity, props.schedule.id]))
  const [held, setHeld] = createSignal(unresolved.get(key()))
  const [busy, setBusy] = createSignal(false)
  const [partial, setPartial] = createSignal(partialResults.get(key()))
  // Message key of the last request proven to have had no effect.
  const [refusal, setRefusal] = createSignal<string>()
  const connection = createMemo(() => ({ client: instances().get(props.instanceId)?.client,
    generation: getOpenCodeInstanceGeneration(props.instanceId) }), undefined,
    { equals: (a, b) => Boolean(a && a.client === b.client && a.generation === b.generation) })
  let generation = 0
  // The exact partial request a refresh's own status read just confirmed, in its context.
  let witness: { generation: number; intent: RecurrenceControlIntent } | undefined
  createEffect(() => {
    const identity = key(); props.active()
    connection()
    generation++; setHeld(unresolved.get(identity)); setPartial(partialResults.get(identity)); setBusy(false); setRefusal(undefined)
  })
  onCleanup(() => { generation++ })
  const incomplete = () => props.schedule.controls.filter(control => control.controlsComplete !== true)
  // A partial Pause/Stop keeps its exact retry ahead of any earlier unknown start intent.
  const outstanding = () => [...incomplete()].reverse().find(control => control.action === "pause" || control.action === "stop") ?? incomplete()[0]
  const current = () => {
    releases()
    const intent = held()
    return intent && unresolved.get(key()) === intent ? intent : undefined
  }
  const heldIntent = () => {
    const control = outstanding(), local = current()
    // An owned native snapshot may contain another client's later partial denial.
    // Prefer that exact retry over the local start it superseded, but never over
    // an unrecorded/in-flight local request or a local partial Pause/Stop.
    const newerPartial = local && START_INTENTS.includes(local.action) && control?.action
      && (control.action === "pause" || control.action === "stop") && control.revision !== undefined
      && control.revision > local.expectedRevision + 1 && incomplete().some(item => item.requestID === local.requestID
        && item.action === local.action && item.expectedRevision === local.expectedRevision)
    return (newerPartial ? undefined : local) ?? (control?.action ? { scheduleID: props.schedule.id, requestID: control.requestID,
      expectedRevision: control.expectedRevision, action: control.action, directory: props.directory } : undefined)
  }
  /** The held request is an unknown start intent (Play, Resume, Check or Run now) that
   * the native snapshot records as incomplete, with no Pause/Stop partial. Native then
   * offers and admits a new explicit Resume/Pause/Stop/Check that supersedes it; the
   * original is never resent and its own exact status still settles it. */
  const supersedable = () => {
    const intent = heldIntent()
    return Boolean(intent && START_INTENTS.includes(intent.action) && incomplete().every(control => control.action && START_INTENTS.includes(control.action))
      && incomplete().some(control => control.requestID === intent.requestID && control.action === intent.action
        && control.expectedRevision === intent.expectedRevision))
  }
  const capable = (action: RecurrenceAction) => props.enabled() && !busy() && props.schedule.actions.includes(action)
    && (!heldIntent() && !outstanding() || SUPERSEDING.includes(action) && supersedable())
  const retryCapable = () => {
    const intent = heldIntent(), result = partial() ?? outstanding()
    return Boolean(intent && result && partialRecurrenceControl(result, intent)) && props.retryEnabled() && !busy()
  }
  const settle = (intent: RecurrenceControlIntent, identity: string, refusal?: string, visible = true) => {
    if (unresolved.get(identity) !== intent) return
    unresolved.delete(identity); partialResults.delete(identity); setReleases(value => value + 1)
    // Only the request's own context shows its outcome and revalidates; a late
    // release never overwrites a newer view's message or state.
    if (!visible || key() !== identity) return
    setHeld(undefined); setPartial(undefined); setRefusal(refusal); props.refresh()
  }
  const finish = (result: RecurrenceControlStatus, intent: RecurrenceControlIntent, identity: string) => {
    const rejected = rejectedRecurrenceControl(result, intent)
    if (completedRecurrenceControl(result, intent) || rejected) settle(intent, identity, rejected)
    else if (partialRecurrenceControl(result, intent)) { partialResults.set(identity, result); setPartial(result); props.refresh() }
    // Still unknown: reread the row so native's offered superseding actions appear.
    else props.refresh()
  }
  const act = async (action: RecurrenceAction, retry?: RecurrenceControlIntent) => {
    if (retry ? !retryCapable() : !capable(action)) return
    const identity = key(), captured = generation, instanceId = props.instanceId
    const intent = retry ?? createRecurrenceControlIntent(props.schedule.id, props.schedule.revision, action, props.directory)
    unresolved.set(identity, intent); setHeld(intent); setBusy(true); setRefusal(undefined)
    try {
      if (action === "run-now") {
        const result = await serverApi.runMissionRecurrenceNow(instanceId, intent)
        if (captured === generation && key() === identity && completedRecurrenceManual(result, intent)) settle(intent, identity)
      } else {
        const result = await serverApi.controlMissionRecurrence(instanceId, intent.scheduleID, { ...intent, ...(retry ? { retry: true } : {}) })
        if (captured === generation && key() === identity) finish(result, intent, identity)
      }
    } catch (error) {
      // A proven no-effect refusal releases this new request and refreshes the row;
      // anything else stays held for Check status, never resent. A refused retry
      // leaves the original partial request held.
      const refusal = retry ? undefined : recurrenceControlRefusalKey(error)
      // The exact request is released wherever it is; only its own context sees the message.
      if (refusal) settle(intent, identity, refusal, captured === generation)
    }
    finally { if (captured === generation) setBusy(false) }
  }
  /** Read-only status read. A refresh (`reconcile`) records a witness only when its
   * own completed read, still in this context, leaves the exact request partial. */
  const check = async (reconcile = false): Promise<boolean> => {
    const intent = heldIntent(), identity = key(), captured = generation
    witness = undefined
    // A refresh's own row read must not skip it; the explicit button keeps the full gate.
    if (!intent || busy() || !(reconcile ? props.retryEnabled() : props.enabled())) return false
    unresolved.set(identity, intent); setHeld(intent)
    setBusy(true)
    try {
      if (intent.action === "run-now") {
        const result = await serverApi.missionRecurrenceRunNowStatus(props.instanceId, intent)
        const rejected = rejectedRecurrenceControl(result, intent)
        if (captured === generation && key() === identity) {
          if (completedRecurrenceManual(result, intent) || rejected) settle(intent, identity, rejected)
          else props.refresh()
        }
      } else {
        const result = await serverApi.missionRecurrenceControlStatus(props.instanceId, intent.scheduleID, intent)
        if (captured === generation && key() === identity) {
          finish(result, intent, identity)
          if (reconcile && partialRecurrenceControl(result, intent)) witness = { generation, intent }
        }
      }
    } catch { /* Retain the exact request identity. */ }
    finally { if (captured === generation) setBusy(false) }
    return Boolean(witness)
  }
  /** Resends only the request its preceding read witnessed, once, in that same context. */
  const resend = () => {
    const read = witness, intent = heldIntent()
    witness = undefined
    return read && read.generation === generation && intent && sameIntent(intent, read.intent) && retryCapable()
      ? act(read.intent.action, read.intent) : Promise.resolve()
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
  const primaryAction = () => !heldIntent() ? PRIMARY.find(action => props.schedule.actions.includes(action))
    : supersedable() ? PRIMARY.find(action => SUPERSEDING.includes(action) && props.schedule.actions.includes(action)) : undefined
  const statusAction = (): MissionPrimaryAction => ({ key: "status", label: t("missionsPanel.action.checkStatus"),
    ariaLabel: t("missions.recurrence.check", { id: props.schedule.title }), disabled: busy() || !props.enabled(), onSelect: () => void check() })
  const primary = (): MissionPrimaryAction | undefined => {
    const action = primaryAction()
    if (heldIntent() && !action) return statusAction()
    return action ? { key: action, label: label(action), ariaLabel: description(action), disabled: !capable(action), onSelect: () => act(action) } : undefined
  }
  // Always the schedule's own Stop, disabled when unavailable or a request is held,
  // so the toolbar never falls back to the one-time Mission wording.
  const stopAction = (): MissionPrimaryAction => ({ key: "stop", label: label("stop"), ariaLabel: description("stop"), disabled: !capable("stop"), onSelect: stop })
  // The panel refresh first reads the exact request's status, then resends it
  // only when that completed read leaves it partially applied.
  const retry: MissionControlRetry = { pending: () => Boolean(heldIntent()) && props.retryEnabled(),
    reconcile: () => check(true), resend }
  // Always present for schedules, disabled while unavailable or a request is held.
  const runNow = (): MissionPrimaryAction => ({ key: "run-now", label: label("run-now"), ariaLabel: description("run-now"),
    disabled: !capable("run-now"), onSelect: () => act("run-now") })
  const feedback = <Show when={heldIntent()} fallback={<Show when={refusal()}>{message => <small role="status">{t(message())}</small>}</Show>}>
    <small role="status">{t("missions.recurrence.uncertain")}</small></Show>
  // While a superseding action holds the primary place, the unknown intent's exact status read stays one click away.
  const statusButton = <button type="button" class="window-text-button" title={statusAction().ariaLabel} aria-label={statusAction().ariaLabel}
    disabled={statusAction().disabled} onClick={() => statusAction().onSelect()}>{statusAction().label}</button>
  const superseding = createMemo(() => Boolean(heldIntent() && primaryAction()))
  const secondary = () => superseding() ? statusButton : undefined
  return { primary, stop: stopAction, runNow, retry, feedback, secondary }
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
  // An exact retry names its held identity, not the snapshot revision: the
  // explicit refresh's own in-flight row read must not silently skip it.
  const admissible = () => !error() && props.active() && snapshot()?.projectID === props.projectID && Boolean(props.projectID)
  const valid = () => !loading() && admissible()
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
        get instanceId() { return props.instanceId }, get directory() { return props.scope }, active: props.active, enabled: valid, retryEnabled: admissible,
        refresh: () => setRevision(value => value + 1) })
      const unregister = props.registerRetry?.(controls.retry)
      onCleanup(() => unregister?.())
      return <section id={props.detailId} class="mission-detail mission-schedule-detail" aria-label={schedule().title}>
        {/* A running passage's summary opens what is happening now; otherwise the schedule reader. */}
        <MissionActionBar label={t("missionsPanel.picker.actions")}
          reading={props.passage ? props.passage.reading : reading(schedule().id)}
          onToggleReader={() => props.passage ? props.passage.onToggle() : read(schedule().id)}
          primary={controls.primary()} stop={controls.stop()} onOpenConversation={props.passage?.onOpenConversation}
          runNow={controls.runNow()} feedback={controls.feedback} secondary={controls.secondary()} />
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
