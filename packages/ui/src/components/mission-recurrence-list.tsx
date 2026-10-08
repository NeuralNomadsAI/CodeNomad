import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Eye, Play, Pause, Square, Search, Zap } from "lucide-solid"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionListItem } from "./mission-list-item"
import { useMissionRecurrence, type RecurrenceSchedule, type RecurrenceAction } from "../stores/mission-recurrence"
import { missionProjectView, updateMissionProjectView } from "../stores/mission-view-state"
import { showSessionChat } from "../stores/session-previews"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { createRecurrenceControlIntent, completedRecurrenceControl, type RecurrenceControlIntent } from "../lib/mission-recurrence-control"

// Lost replies survive remounts. Only an exact status read releases the hold.
const unresolved = new Map<string, RecurrenceControlIntent>()
function RecurrenceControls(props: { schedule: RecurrenceSchedule; identity: string; instanceId: string;
  active: () => boolean; enabled: () => boolean; refresh: () => void }) {
  const { t } = useI18n()
  const key = createMemo(() => JSON.stringify([props.identity, props.schedule.id]))
  const [held, setHeld] = createSignal(unresolved.get(key()))
  const [busy, setBusy] = createSignal(false)
  const [confirmStop, setConfirmStop] = createSignal(false)
  const connection = createMemo(() => ({ client: instances().get(props.instanceId)?.client,
    generation: getOpenCodeInstanceGeneration(props.instanceId) }), undefined,
    { equals: (a, b) => Boolean(a && a.client === b.client && a.generation === b.generation) })
  let generation = 0
  createEffect(() => {
    const identity = key(); props.active()
    connection()
    generation++; setHeld(unresolved.get(identity)); setBusy(false); setConfirmStop(false)
  })
  onCleanup(() => { generation++ })
  const heldIntent = () => held() ?? (props.schedule.control && props.schedule.control.status !== "completed"
    ? { scheduleID: props.schedule.id, requestID: props.schedule.control.requestID, expectedRevision: props.schedule.revision } : undefined)
  const capable = (action: RecurrenceAction) => props.enabled() && !busy() && !heldIntent() && props.schedule.actions.includes(action)
  const finish = (result: Parameters<typeof completedRecurrenceControl>[0], intent: RecurrenceControlIntent, identity: string) => {
    if (!completedRecurrenceControl(result, intent) || unresolved.get(identity) !== intent) return
    unresolved.delete(identity); setHeld(undefined); props.refresh()
  }
  const act = async (action: RecurrenceAction) => {
    if (!capable(action)) return
    const identity = key(), captured = generation, instanceId = props.instanceId
    const intent = createRecurrenceControlIntent(props.schedule.id, props.schedule.revision)
    unresolved.set(identity, intent); setHeld(intent); setBusy(true); setConfirmStop(false)
    try {
      const result = await serverApi.controlMissionRecurrence(instanceId, intent.scheduleID, action, intent)
      if (captured === generation && key() === identity) finish(result, intent, identity)
    } catch { /* Check status, never resend. */ }
    finally { if (captured === generation) setBusy(false) }
  }
  const check = async () => {
    const intent = heldIntent(), identity = key(), captured = generation
    if (!intent || busy() || !props.enabled()) return
    unresolved.set(identity, intent); setHeld(intent)
    setBusy(true)
    try {
      const result = await serverApi.missionRecurrenceControlStatus(props.instanceId, intent.scheduleID, intent)
      if (captured === generation && key() === identity) finish(result, intent, identity)
    } catch { /* Retain the exact request identity. */ }
    finally { if (captured === generation) setBusy(false) }
  }
  return <div class="mission-recurrence-controls">
    <For each={props.schedule.actions}>{action => <button type="button" class="mission-control-icon-button"
      disabled={!capable(action)} aria-label={t(`missions.recurrence.${action}`, { id: props.schedule.title })}
      title={t(`missions.recurrence.${action}`, { id: props.schedule.title })}
      onClick={() => action === "stop" ? setConfirmStop(true) : void act(action)}>
      {action === "pause" ? <Pause class="h-4 w-4" /> : action === "stop" ? <Square class="h-4 w-4" />
        : action === "run-now" ? <Zap class="h-4 w-4" /> : <Play class="h-4 w-4" />}
    </button>}</For>
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
  const next = (schedule: RecurrenceSchedule) => schedule.nextDueAt === null ? t("missions.simple.noNext")
    : new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: schedule.clock.zone }).format(schedule.nextDueAt)
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
      <For each={snapshot()?.schedules}>{schedule => <MissionListItem text={<><span class="badge-shape">{t("missions.simple.daily", schedule.clock)}</span> {schedule.title}</>}
        title={schedule.title} selected={props.selectedSchedule === schedule.id} onSelect={() => props.onSelect?.(schedule.id)}
        status={<><span>{t(`missions.recurrence.state.${schedule.state}`)}</span> · <bdi>{next(schedule)}</bdi></>} statusKind={schedule.state}
        actions={[{ key: "read", label: t("missions.recurrence.read", { id: schedule.title }), checked: reading(schedule.id),
          icon: <Eye class="h-3.5 w-3.5" />, onSelect: () => read(schedule.id) }]} />}</For>
    </nav>
    <Show when={error()}><p role="status">{t(snapshot() ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
    <Show when={selected()}>{schedule => <section class="mission-schedule-detail" aria-label={schedule().title}>
      <header class="window-header"><strong class="window-title">{schedule().title}</strong>
        <button type="button" class="mission-control-icon-button icon-toggle" aria-pressed={reading(schedule().id)}
          aria-label={t("missions.recurrence.read", { id: schedule().title })} onClick={() => read(schedule().id)}><Eye class="h-4 w-4" /></button></header>
      <p>{t("missions.simple.next")}: <bdi>{next(schedule())}</bdi></p>
      <RecurrenceControls schedule={schedule()} identity={JSON.stringify([props.instanceId, props.projectID, props.scope])}
        instanceId={props.instanceId} active={props.active} enabled={valid} refresh={() => setRevision(value => value + 1)} />
      <Show when={schedule().interruptionReason}><p role="status">{schedule().interruptionReason?.kind === "service-restart"
        ? t("missions.simple.restart") : t("missions.simple.error", { code: schedule().interruptionReason?.code ?? "" })}</p></Show>
      <Show when={schedule().pending?.status === "uncertain" || schedule().state === "interrupted" && schedule().pending}>
        <p role="status">{t("missions.simple.resumeExplanation")}</p></Show>
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
