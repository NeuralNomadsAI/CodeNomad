import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Eye, Play, Pause, Square, RefreshCw } from "lucide-solid"
import type { MissionRecurrenceSnapshot } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { MissionDisclosure } from "./mission-disclosure"
import { useMissionRecurrence, useMissionCurrentPassage } from "../stores/mission-recurrence"
import { missionDisclosureOpen, missionProjectView, updateMissionProjectView } from "../stores/mission-view-state"
import { showSessionChat } from "../stores/session-previews"
import { getPermissionQueue, instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { getFormQueue } from "../stores/forms"
import { selectMissionAttention } from "./mission-attention-model"
import { focusInterruption } from "../stores/interruption-navigation"
import { createRecurrenceControlIntent, completedRecurrenceControl, type RecurrenceControlIntent } from "../lib/mission-recurrence-control"

type Schedule = MissionRecurrenceSnapshot["schedules"][number]
type Action = "play" | "pause" | "stop"
type Intent = RecurrenceControlIntent
// An uncertain intent survives a panel remount, never an automatic replay.
const unresolved = new Map<string, Intent>()
const acknowledged = new Map<string, Intent>()

function RecurrenceControls(props: { schedule: Schedule; identity: string; instanceId: string; directory: string;
  active: () => boolean; enabled: () => boolean; refresh: () => void }) {
  const { t } = useI18n()
  // Fresh reads update the schedule object. Only a changed semantic
  // identity or inactive view may fence an in-flight control/status response.
  const key = createMemo(() => JSON.stringify([props.identity, props.schedule.id]))
  const connectionBinding = createMemo(() => ({ client: instances().get(props.instanceId)?.client,
    generation: getOpenCodeInstanceGeneration(props.instanceId) }), undefined,
    { equals: (a, b) => Boolean(a && a.client === b.client && a.generation === b.generation) })
  const [held, setHeld] = createSignal<Intent | undefined>(unresolved.get(key()))
  const [busy, setBusy] = createSignal(false)
  const [uncertain, setUncertain] = createSignal(Boolean(held()))
  let generation = 0
  createEffect(() => {
    const identity = key(); props.active()
    connectionBinding()
    setHeld(unresolved.get(identity)); setUncertain(Boolean(unresolved.get(identity)))
    setBusy(false)
    generation++
  })
  createEffect(() => {
    const identity = key(), intent = acknowledged.get(identity), schedule = props.schedule
    if (!intent || schedule.revision < intent.expectedRevision + 1 || schedule.epoch === null
      || schedule.epoch === undefined || schedule.epoch < intent.expectedEpoch + 1) return
    if (unresolved.get(identity) === intent) unresolved.delete(identity)
    acknowledged.delete(identity); setHeld(undefined); setUncertain(false)
  })
  onCleanup(() => { generation++ })
  const offered = (action: Action) => Number.isSafeInteger(props.schedule.epoch) && props.schedule.epoch! >= 0
    && Number.isSafeInteger(props.schedule.revision) && props.schedule.revision >= 0
    && props.schedule.controlCapability?.version === 1 && Array.isArray(props.schedule.controlCapability.actions)
    && props.schedule.controlCapability.actions.includes(action)
    && (action !== "play" || !props.schedule.pendingPassageID)
    // Denial authority is independent of the execution/activity projection: an
    // unavailable replacement artifact can still authorize Pause/Stop safely.
    && (action === "play" ? ["paused", "interrupted"].includes(props.schedule.state) : props.schedule.controlRetry?.action !== action)
  const retry = () => {
    const retry = props.schedule.controlRetry, control = props.schedule.nativeControl
    if (!retry || retry.scheduleID !== props.schedule.id || !["pause", "stop"].includes(retry.action)
      || !Number.isSafeInteger(retry.expectedEpoch) || retry.expectedEpoch < 0 || retry.expectedEpoch + 1 !== props.schedule.epoch
      || !Number.isSafeInteger(retry.expectedRevision) || retry.expectedRevision < 0 || retry.expectedRevision + 1 > props.schedule.revision
      || props.schedule.controlsComplete === true || props.schedule.controlCapability?.version !== 1
      || !Array.isArray(props.schedule.controlCapability.actions)
      || !props.schedule.controlCapability.actions.includes(retry.action)
      || control && (control.requestID !== retry.requestID || control.action !== retry.action)) return
    return retry
  }
  const sameIntent = (a: Intent, b: NonNullable<ReturnType<typeof retry>>) => a.scheduleID === b.scheduleID
    && a.requestID === b.requestID && a.action === b.action && a.expectedRevision === b.expectedRevision && a.expectedEpoch === b.expectedEpoch
  const retryCapable = () => Boolean(retry()) && props.enabled() && !busy()
    && (!held() || sameIntent(held()!, retry()!) && held()!.directory === props.directory)
  const capable = (action: Action) => offered(action) && props.enabled() && !busy() && !held() && !props.schedule.controlRetry
  const settle = (intent: Intent, identity: string) => {
    if (unresolved.get(identity) !== intent) return
    acknowledged.set(identity, intent)
    if (key() === identity) props.refresh()
  }
  const act = async (action: Action, retrying = false) => {
    if (retrying ? !retryCapable() : !capable(action)) return
    const identity = key(), instanceId = props.instanceId, schedule = props.schedule, revision = schedule.revision,
      epoch = schedule.epoch!, directory = props.directory, captured = generation
    const original = retrying ? retry()! : undefined
    const client = instances().get(instanceId)?.client, connection = getOpenCodeInstanceGeneration(instanceId)
    const connectionCurrent = () => instances().get(instanceId)?.client === client && getOpenCodeInstanceGeneration(instanceId) === connection
    setBusy(true)
    try {
      const proposed = await createRecurrenceControlIntent(schedule.id, original?.expectedEpoch ?? epoch, action,
        original?.expectedRevision ?? revision, directory)
      // Navigation and refreshed epoch/revision fence asynchronous digest work.
      if (captured !== generation || identity !== key() || !props.enabled() || !connectionCurrent() || props.schedule.revision !== revision
        || props.schedule.epoch !== epoch || props.directory !== directory || props.instanceId !== instanceId) return
      if (retrying ? !retry() || !sameIntent(proposed, retry()!) || !sameIntent(proposed, original!)
        || held() && !sameIntent(held()!, original!) : !offered(action) || held() || props.schedule.controlRetry) return
      const intent = retrying ? { ...proposed, retry: true } : proposed
      unresolved.set(identity, intent); setHeld(intent)
      try {
        const result = await serverApi.controlMissionRecurrence(instanceId, schedule.id, intent)
        if (connectionCurrent() && completedRecurrenceControl(result, intent))
          settle(intent, identity)
        else if (captured === generation && key() === identity && unresolved.get(identity) === intent) setUncertain(true)
      } catch { if (captured === generation && key() === identity && unresolved.get(identity) === intent) setUncertain(true) }
    } finally { if (captured === generation) setBusy(false) }
  }
  const check = async () => {
    const intent = held(), identity = key(), captured = generation
    if (!intent || busy() || !props.enabled()) return
    setBusy(true)
    try {
      const result = await serverApi.missionRecurrenceControlStatus(props.instanceId, intent.scheduleID, intent)
      if (captured === generation && key() === identity && result.outcome === "committed"
        && completedRecurrenceControl(result, intent)) settle(intent, identity)
    } catch { /* An unknown exact receipt stays held; never replay the mutation. */ }
    finally { if (captured === generation) setBusy(false) }
  }
  return <Show when={held() || retry() || ["play", "pause", "stop"].some(action => offered(action as Action))}>
    <div class="mission-recurrence-controls">
      <Show when={offered("play")}><button type="button" class="mission-control-icon-button" disabled={!capable("play")} onClick={() => void act("play")}
        aria-label={t(props.schedule.state === "interrupted" ? "missions.recurrence.resume" : "missions.recurrence.play", { id: props.schedule.id })}
        title={t(props.schedule.state === "interrupted" ? "missions.recurrence.resume" : "missions.recurrence.play", { id: props.schedule.id })}><Play class="h-4 w-4" /></button></Show>
      <Show when={offered("pause")}><button type="button" class="mission-control-icon-button" disabled={!capable("pause")} onClick={() => void act("pause")}
        aria-label={t("missions.recurrence.pause", { id: props.schedule.id })} title={t("missions.recurrence.pause", { id: props.schedule.id })}><Pause class="h-4 w-4" /></button></Show>
      <Show when={offered("stop")}><button type="button" class="mission-control-icon-button" disabled={!capable("stop")} onClick={() => void act("stop")}
        aria-label={t("missions.recurrence.stop", { id: props.schedule.id })} title={t("missions.recurrence.stop", { id: props.schedule.id })}><Square class="h-4 w-4" /></button></Show>
      <Show when={held()}><button type="button" class="mission-control-icon-button" disabled={busy() || !props.enabled()}
        onClick={() => void check()} aria-label={t("missions.recurrence.check", { id: props.schedule.id })}
        title={t("missions.recurrence.check", { id: props.schedule.id })}><RefreshCw class="h-4 w-4" /></button></Show>
      <Show when={retry()}><button type="button" class="mission-control-icon-button" disabled={!retryCapable()}
        onClick={() => { const intent = retry(); if (intent) void act(intent.action, true) }}
        aria-label={t("missions.recurrence.retry", { id: props.schedule.id })} title={t("missions.recurrence.retry", { id: props.schedule.id })}>
        <RefreshCw class="h-4 w-4" /></button></Show>
      <Show when={props.schedule.nativeControl?.pending.length}><small>{t("missions.recurrence.pendingTargets", { count: props.schedule.nativeControl!.pending.length })}</small></Show>
      <Show when={uncertain()}><small role="status">{t("missions.recurrence.uncertain")}</small></Show>
    </div>
  </Show>
}

export function MissionRecurrenceList(props: { instanceId: string; projectID?: string; scope: string; active: () => boolean; refresh: number;
  selectedSchedule?: string; onSelect?: (id: string) => void; onRead?: (restoreChat?: boolean) => void }) {
  const { t } = useI18n()
  const key = () => JSON.stringify([props.instanceId, props.projectID, props.scope])
  const [revision, setRevision] = createSignal(0)
  const { snapshot, error, loading } = useMissionRecurrence({ instanceId: () => props.instanceId,
    projectID: () => props.projectID, directory: () => props.scope, refresh: () => props.refresh + revision(),
    active: () => props.active() && missionDisclosureOpen(props.scope, "recurrence", true) })
  const valid = () => !loading() && !error() && props.active() && snapshot()?.projectID === props.projectID && Boolean(props.projectID)
  const current = useMissionCurrentPassage({ instanceId: () => props.instanceId, projectID: () => props.projectID,
    directory: () => props.scope, scheduleID: () => props.selectedSchedule, active: props.active })
  const reading = (id: string) => {
    const current = missionProjectView(props.scope).reader
    return current?.kind === "recurrence" && current.missionId === id && current.instanceId === props.instanceId
      && current.projectID === snapshot()?.projectID
  }

  return <MissionDisclosure missionId={props.scope} name="recurrence" defaultOpen title={t("missions.recurrence.list")}
    actions={<button type="button" class="mission-control-icon-button" disabled={loading() || !props.active()}
      aria-label={t("missions.recurrence.refresh")} title={t("missions.recurrence.refresh")}
      onClick={() => setRevision(value => value + 1)}><RefreshCw class="h-4 w-4" /></button>}>
    <div class="mission-recurrence-list">
      <Show when={loading() && !snapshot()}><p role="status">{t("missions.control.loading")}</p></Show>
      <Show when={error()}><p role="status">{t(snapshot() ? "missions.recurrence.stale" : "missions.recurrence.unavailable")}</p></Show>
      <Show when={snapshot() && !snapshot()!.schedules.length}><p>{t("missions.recurrence.empty")}</p></Show>
      <For each={snapshot()?.schedules.map(schedule => schedule.id)}>{id => {
        const schedule = () => snapshot()!.schedules.find(schedule => schedule.id === id)!
        const decisions = createMemo(() => {
          const admission = schedule().pendingAdmission
          if (!admission || error()) return []
          const passage = current.snapshot(), mission = passage?.scheduleID === id && passage.mission?.id === admission.missionID
            && passage.mission.coordinatorSessionId === admission.conversationID ? passage.mission : undefined
          // The selected passage already owns the first, ancestry-aware Attention
          // surface in MissionTracking; do not repeat the same native requests.
          if (mission) return []
          return selectMissionAttention({ actors: [{ sessionId: admission.conversationID }], tasks: [],
            forms: getFormQueue(props.instanceId), permissions: getPermissionQueue(props.instanceId) })
        })
        return <article class="mission-recurrence-item">
        <Show when={decisions().length}><div class="mission-recurrence-decisions"><strong>{t("missions.control.attention.title")}</strong>
          <For each={decisions()}>{request => <button type="button" class="window-text-button" onClick={() => {
            const selected = decisions().find(item => item.id === request.id && item.sessionId === request.sessionId)
            if (selected && selected.kind !== "blocked") {
              props.onRead?.(true)
              focusInterruption(props.instanceId, selected.sessionId, selected.id.slice(selected.kind.length + 1), selected.kind)
            }
          }}>{t(`missions.control.attention.${request.kind}`)}: {request.title}</button>}</For>
        </div></Show>
        <button type="button" class="window-text-button icon-toggle" aria-pressed={props.selectedSchedule === id}
          onClick={() => props.onSelect?.(id)}><strong>{schedule().clock.time} · <bdi>{schedule().clock.zone}</bdi></strong></button>
        <button type="button" class="mission-control-icon-button icon-toggle mission-recurrence-read"
          aria-label={t("missions.recurrence.read", { id })} title={t("missions.recurrence.read", { id })} aria-pressed={reading(id)}
          onClick={() => {
            const wasReading = reading(id)
            showSessionChat(props.scope)
            updateMissionProjectView(props.scope, { reader: wasReading ? undefined : { kind: "recurrence", missionId: id,
              instanceId: props.instanceId, projectID: snapshot()!.projectID } })
            if (!wasReading) props.onRead?.()
          }}><Eye class="h-3.5 w-3.5" aria-hidden="true" /></button>
        <span>{t("missions.recurrence.settled", { count: schedule().settledCount })}</span>
        <small><bdi>{schedule().id}</bdi></small>
        <span>{t(`missions.recurrence.state.${schedule().state}`)}</span>
        <RecurrenceControls schedule={schedule()} instanceId={props.instanceId} directory={props.scope} identity={key()}
          active={props.active} enabled={valid} refresh={() => setRevision(value => value + 1)} />
        <Show when={schedule().pendingPassageID}><span>{t("missions.recurrence.pending")}</span></Show>
        <Show when={schedule().latestResult}><span>{t("missions.recurrence.latest")}: {t(`missions.recurrence.result.${schedule().latestResult!.status}`)}</span></Show>
        <Show when={schedule().pendingStatus}><span role="status">{t(`missions.recurrence.pending.${schedule().pendingStatus}`)}</span></Show>
      </article>}}</For>
    </div>
  </MissionDisclosure>
}
