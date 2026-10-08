import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Eye, Play, Pause, Square, Search, Zap, RotateCcw } from "lucide-solid"
import { Tooltip } from "@kobalte/core/tooltip"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionListItem } from "./mission-list-item"
import { useMissionRecurrence, type RecurrenceSchedule, type RecurrenceAction } from "../stores/mission-recurrence"
import { missionProjectView, updateMissionProjectView } from "../stores/mission-view-state"
import { showSessionChat } from "../stores/session-previews"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { createRecurrenceControlIntent, completedRecurrenceControl, completedRecurrenceManual, partialRecurrenceControl,
  type RecurrenceControlStatus, type RecurrenceControlIntent } from "../lib/mission-recurrence-control"

// Lost replies survive remounts. Only an exact status read releases the hold.
const unresolved = new Map<string, RecurrenceControlIntent>()
const partialResults = new Map<string, RecurrenceControlStatus>()
function RecurrenceControls(props: { schedule: RecurrenceSchedule; identity: string; instanceId: string;
  directory: string; active: () => boolean; enabled: () => boolean; refresh: () => void }) {
  const { t } = useI18n()
  const key = createMemo(() => JSON.stringify([props.identity, props.schedule.id]))
  const [held, setHeld] = createSignal(unresolved.get(key()))
  const [busy, setBusy] = createSignal(false)
  const [partial, setPartial] = createSignal(partialResults.get(key()))
  const [confirmStop, setConfirmStop] = createSignal(false)
  const connection = createMemo(() => ({ client: instances().get(props.instanceId)?.client,
    generation: getOpenCodeInstanceGeneration(props.instanceId) }), undefined,
    { equals: (a, b) => Boolean(a && a.client === b.client && a.generation === b.generation) })
  let generation = 0
  createEffect(() => {
    const identity = key(); props.active()
    connection()
    generation++; setHeld(unresolved.get(identity)); setPartial(partialResults.get(identity)); setBusy(false); setConfirmStop(false)
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
    unresolved.set(identity, intent); setHeld(intent); setBusy(true); setConfirmStop(false)
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
  return <div class="mission-recurrence-controls">
    <For each={props.schedule.actions}>{action => <Tooltip placement="top" openDelay={300}><Tooltip.Trigger type="button" class="mission-control-icon-button"
      classList={{ "mission-schedule-resume button-primary": action === "resume", "mission-schedule-run-now": action === "run-now" }}
      disabled={!capable(action)} aria-label={t(`missions.recurrence.${action}`, { id: props.schedule.title })}
      title={t(`missions.recurrence.${action}`, { id: props.schedule.title })}
      onClick={() => action === "stop" ? setConfirmStop(true) : void act(action)}>
      {action === "pause" ? <Pause class="h-4 w-4" /> : action === "stop" ? <Square class="h-4 w-4" />
        : action === "run-now" ? <Zap class="h-4 w-4" /> : <Play class="h-4 w-4" />}
      <Show when={action === "resume"}><span>{t("missions.simple.resume")}</span></Show>
      <Show when={action === "run-now"}><span class="mission-schedule-action-label">{t("missions.simple.runNow")}</span></Show>
    </Tooltip.Trigger><Tooltip.Portal><Tooltip.Content class="section-info-tooltip">{t(`missions.recurrence.${action}`, { id: props.schedule.title })}</Tooltip.Content></Tooltip.Portal></Tooltip>}</For>
    <Show when={confirmStop()}><span role="group" aria-label={t("missions.simple.confirmStop", { title: props.schedule.title })}
      onKeyDown={event => { if (event.key === "Escape") setConfirmStop(false) }}>
      <span>{t("missions.simple.confirmStop", { title: props.schedule.title })}</span>
      <button type="button" class="window-text-button" onClick={() => void act("stop")}>{t("missions.simple.stop")}</button>
      <button type="button" class="window-text-button" onClick={() => setConfirmStop(false)}>{t("missions.simple.cancel")}</button>
    </span></Show>
    <Show when={heldIntent()}><button type="button" class="mission-control-icon-button" disabled={busy() || !props.enabled()}
      onClick={() => void check()} aria-label={t("missions.recurrence.check", { id: props.schedule.title })}
      title={t("missions.recurrence.check", { id: props.schedule.title })}><Search class="h-4 w-4" /></button>
      <small role="status">{t("missions.recurrence.uncertain")}</small></Show>
    <Show when={retryCapable()}><button type="button" class="mission-control-icon-button" onClick={() => void act(heldIntent()!.action, true)}
      aria-label={t("missions.recurrence.retry", { id: props.schedule.title })} title={t("missions.recurrence.retry", { id: props.schedule.title })}>
      <RotateCcw class="h-4 w-4" /></button></Show>
  </div>
}

export function MissionRecurrenceList(props: { instanceId: string; projectID?: string; scope: string; active: () => boolean; refresh: number;
  selectedSchedule?: string; onSelect?: (id: string) => void; onRead?: (restoreChat?: boolean) => void;
  children?: JSX.Element; tracking?: JSX.Element }) {
  const { t, locale } = useI18n()
  const [revision, setRevision] = createSignal(0)
  const { snapshot, error, loading } = useMissionRecurrence({ instanceId: () => props.instanceId,
    projectID: () => props.projectID, directory: () => props.scope, refresh: () => props.refresh + revision(), active: props.active })
  const valid = () => !loading() && !error() && props.active() && snapshot()?.projectID === props.projectID && Boolean(props.projectID)
  const selected = () => snapshot()?.schedules.find(schedule => schedule.id === props.selectedSchedule)
  const hasNext = (schedule: RecurrenceSchedule) => schedule.state === "running" && schedule.nextDueAt !== null
  const next = (schedule: RecurrenceSchedule) => !hasNext(schedule) ? t("missions.simple.noNext")
    : new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: schedule.clock.zone }).format(schedule.nextDueAt!)
  const reading = (id: string) => {
    const reader = missionProjectView(props.scope).reader
    return reader?.kind === "recurrence" && reader.missionId === id && reader.instanceId === props.instanceId && reader.projectID === props.projectID
  }
  const read = (id: string) => {
    const wasReading = reading(id)
    showSessionChat(props.scope)
    updateMissionProjectView(props.scope, { reader: wasReading ? undefined : { kind: "recurrence", missionId: id,
      instanceId: props.instanceId, projectID: props.projectID } })
    if (!wasReading) props.onRead?.()
  }
  return <>
    <nav class="mission-control-index" aria-label={t("missions.control.mapLabel")}>
      {props.children}
      <For each={snapshot()?.schedules}>{schedule => <MissionListItem text={schedule.title}
        secondary={<span class="neutral-badge badge-shape"><bdi>{t("missions.simple.daily", schedule.clock)}</bdi></span>}
        title={schedule.title} selected={props.selectedSchedule === schedule.id} onSelect={() => props.onSelect?.(schedule.id)}
        status={<><span>{t(`missions.recurrence.state.${schedule.state}`)}</span><Show when={hasNext(schedule)}> · <bdi>{next(schedule)}</bdi></Show></>} statusKind={schedule.state}
        actions={[{ key: "read", label: t("missions.recurrence.read", { id: schedule.title }), checked: reading(schedule.id),
          icon: <Eye class="h-3.5 w-3.5" />, onSelect: () => read(schedule.id) }]} />}</For>
    </nav>
    <Show when={error()}><p role="status">{t(snapshot() ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
    <Show when={selected()}>{schedule => <section class="mission-schedule-detail" aria-label={schedule().title}>
      <header class="window-header"><strong class="window-title">{schedule().title}</strong>
        <button type="button" class="mission-control-icon-button icon-toggle" aria-pressed={reading(schedule().id)}
          aria-label={t("missions.recurrence.read", { id: schedule().title })} onClick={() => read(schedule().id)}><Eye class="h-4 w-4" /></button></header>
      <Show when={hasNext(schedule())}><p>{t("missions.simple.next")}: <bdi>{next(schedule())}</bdi></p></Show>
      <RecurrenceControls schedule={schedule()} identity={JSON.stringify([props.instanceId, props.projectID, props.scope])}
        instanceId={props.instanceId} directory={props.scope} active={props.active} enabled={valid} refresh={() => setRevision(value => value + 1)} />
      <Show when={schedule().state === "interrupted" || schedule().pending?.status === "uncertain"}>
        <p role="status">{schedule().interruptionReason === "service-restart" ? t("missions.simple.restart")
          : schedule().interruptionReason === "error" ? t("missions.recurrence.interruptedError")
          : t("missions.simple.resumeExplanation")}</p></Show>
      {props.tracking}
      <MissionDisclosure missionId={schedule().id} name="passage-history" defaultOpen={false} title={t("missions.recurrence.history")}>
        <For each={schedule().history}>{item => <div class="mission-recurrence-history-item">
          <bdi>{new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: schedule().clock.zone }).format(item.dueAt)}</bdi>
          <span>{t(`missions.recurrence.result.${item.outcome}`)}</span>
        </div>}</For>
      </MissionDisclosure>
      <MissionDisclosure missionId={schedule().id} name="schedule-technical" defaultOpen={false} title={t("missions.control.task.details")}>
        <bdi>{schedule().id}</bdi>
      </MissionDisclosure>
    </section>}</Show>
  </>
}
