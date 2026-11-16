import { For, Show, createMemo, createSignal, createEffect, untrack, type JSX } from "solid-js"
import { useI18n } from "../lib/i18n"
import { useMissionSchedules, unifiedScheduleHold, type UnifiedMissionSchedule } from "../stores/mission-schedules"
import { missionMarkStateKey, unifiedScheduleMark, type MissionPickerEntry } from "./mission-picker-model"
import { markScheduleSuccessSeen, scheduleSuccessSeen, seedScheduleSuccessSeen } from "../stores/mission-view-state"
import { describeMissionCriteria, missionCriteriaZone } from "./mission-scheduling-summary"
import { createMissionScheduleControls } from "./mission-schedule-controls"
import { MissionActionBar } from "./mission-action-bar"
import { missionLaunchLimit, missionLaunchModel } from "../../../server/src/missions/mission-launch-kind"
import { MissionScheduleDiagnostics } from "./mission-schedule-diagnostics"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { openSettingsConfigFile } from "../stores/settings-screen"
import { missionPassageRequests } from "./mission-passage-requests"

export function createMissionScheduleList(props: { instanceId: string; projectID?: string; directory: string;
  active: () => boolean; enabled: () => boolean; refresh: number; selected?: string; detailId: string;
  onEdit: (id: string) => void; onDeleted: (id: string) => void; onOpenConversation: (id: string) => void;
  tracking?: JSX.Element; passage?: { reading: boolean; onToggle(): void }; onPassage?: (id: string | undefined) => void;
  overview?: { reading: boolean; onToggle(): void };
  onNoPassage?: (id: string) => void;
  selectedRequests?: { passageID: string; count: number } }) {
  const { t, locale } = useI18n()
  const [revision, setRevision] = createSignal(0)
  const list = useMissionSchedules({ instanceId: () => props.instanceId, projectID: () => props.projectID,
    directory: () => props.directory, active: props.active, refresh: () => props.refresh + revision(), selected: () => props.selected })
  const schedules = () => list.rows().filter(row => row.kind === "schedule")
  const seenScope = () => JSON.stringify([props.directory, props.projectID])
  createEffect(() => {
    const docs = schedules(), scope = seenScope()
    if (list.error()) return
    const fresh = docs.filter(doc => list.fresh(doc.id))
    untrack(() => { for (const doc of fresh) seedScheduleSuccessSeen(scope, "scheduled", doc.id,
      doc.latestResult?.outcome === "completed" ? doc.latestResult.id : undefined) })
  })
  createEffect(() => {
    const doc = schedules().find(row => row.id === props.selected)
    // Retire the former passage selection before releasing its current-source demand.
    if (doc && !doc.pendingPassage && list.fresh(doc.id) && !list.loading() && !list.error() && !list.selectionError())
      props.onNoPassage?.(doc.id)
    props.onPassage?.(doc?.pendingPassage ? props.selected : undefined)
  })
  const date = (value: number | null, zone?: string) => value === null ? t("missions.scheduleList.none")
    : new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", ...(zone ? { timeZone: zone } : {}) }).format(value)
  const criteria = (doc: UnifiedMissionSchedule) => describeMissionCriteria(doc.configuration.launch, t, locale(), doc.oneShotAt).join("; ")
  const observed = (doc: UnifiedMissionSchedule) => t(`missions.scheduleList.observed.${doc.observation.state === "known"
    ? doc.observation.nativeStatus ?? "unknown" : doc.observation.state}`)
  const zoneOf = (doc: UnifiedMissionSchedule) => missionCriteriaZone(doc.configuration.launch)
  const nextWake = (doc: UnifiedMissionSchedule) => `${t(doc.observation.kind === "check" ? "missions.scheduleList.nextCheck" : "missions.scheduleList.nextWake")} · ${date(doc.observation.nextDueAt, zoneOf(doc))}`
  const entries = createMemo((): MissionPickerEntry[] => schedules().map(doc => {
    const requests = doc.id === props.selected && doc.pendingPassage?.id === props.selectedRequests?.passageID ? props.selectedRequests?.count ?? 0
      : missionPassageRequests(props.instanceId, doc.pendingPassage?.coordinatorSessionID)
    const held = unifiedScheduleHold(JSON.stringify([props.instanceId, props.projectID, props.directory, doc.id]))
    const mark = unifiedScheduleMark(doc, requests, !doc.latestResult || scheduleSuccessSeen(seenScope(), "scheduled", doc.id, doc.latestResult.id),
      !list.error() && list.fresh(doc.id) && !held)
    const stateKey = missionMarkStateKey(mark)
    return { key: `scheduled:${doc.id}`, title: doc.configuration.title, mark,
      status: [t(stateKey ?? `missions.scheduleList.state.${doc.state}`), requests ? t("missionsPanel.task.input") : "",
        criteria(doc), nextWake(doc)].filter(Boolean).join(" · ") }
  }))
  const refresh = () => setRevision(value => value + 1)
  const publishing = () => unifiedScheduleHold(JSON.stringify([props.instanceId, props.projectID, props.directory, props.selected]))?.phase === "publication"
  /** Inventory-wide notice; the directory owns the shared continuation button. */
  const listView = () => <Show when={list.error()}><p role="status" class="mission-control-stale">{t("missions.scheduleList.readFailed")}</p></Show>
  /** The selected schedule's detail. */
  const view = () => <>
    <Show when={list.selectionError()}>{error => <p class="mission-control-stale" role="status">
      {t(error() === "pending" ? publishing() ? "missions.scheduleList.confirmedRefreshing" : "missions.scheduleList.uncertain" : "missions.scheduleList.readFailed")}
    </p>}</Show>
    <Show when={props.selected && schedules().some(row => row.id === props.selected) ? props.selected : undefined} keyed>{id => {
      const doc = createMemo<UnifiedMissionSchedule>(previous => schedules().find(row => row.id === id) ?? previous!)
      const controls = createMissionScheduleControls({ get instanceId() { return props.instanceId }, get projectID() { return props.projectID },
        get directory() { return props.directory }, document: doc, active: props.active,
        enabled: () => props.enabled() && !list.error() && list.fresh(id), refreshVersion: () => props.refresh + revision(), refresh,
        onDeleted: () => props.onDeleted(id) })
      const [expanded, expand] = createSignal(false)
      const primary = () => (["pause", "resume", "play"] as const).find(action => controls.pendingAction() === action)
        ?? (["pause", "resume", "play"] as const).find(action => doc().availableActions.includes(action))
      const action = (name: "play" | "resume" | "pause" | "stop" | "run-now") => ({ key: name, label: controls.label(name),
        disabled: !controls.capable(name), busy: controls.pendingAction() === name, onSelect: () => controls.act(name) })
      const status = () => controls.progress() ?? (controls.held() ? controls.busy() ? undefined
        : controls.publishing() ? "missions.scheduleList.confirmedRefreshing" : "missions.scheduleList.uncertain"
        : controls.feedback() ?? (controls.refusal() ? "missions.scheduleList.activationRefused"
        : controls.capability() === "missing" ? "missions.scheduling.capability.missing"
        : controls.capability() === "activatable" ? "missions.scheduleList.runNowRequiresEnabled" : undefined))
      const zone = () => zoneOf(doc()), model = createMemo(() => missionLaunchModel(doc().configuration.launch))
      const editable = () => props.active() && props.enabled() && !list.error() && list.fresh(id)
        && !controls.held() && !controls.busy() && doc().availableActions.includes("configure")
      return <section id={props.detailId} class="mission-detail mission-unified-schedule" aria-label={doc().configuration.title}>
        <MissionActionBar label={t("missionsPanel.picker.actions")} reading={props.passage?.reading ?? props.overview?.reading ?? expanded()} onToggleReader={() => props.passage ? props.passage.onToggle() : props.overview ? props.overview.onToggle() : expand(value => !value)}
          primary={primary() ? action(primary()!) : undefined} stop={action("stop")} runNow={action("run-now")}
          onEdit={() => { if (editable()) props.onEdit(id) }} editDisabled={!editable()}
          onDelete={() => void controls.act("delete")} deleteDisabled={!controls.capable("delete")} deleteBusy={controls.pendingAction() === "delete"}
          onOpenConversation={doc().pendingPassage ? () => props.onOpenConversation(doc().pendingPassage!.coordinatorSessionID) : undefined}
          secondary={<Show when={controls.held()}><button type="button" class="window-action" disabled={controls.busy()} onClick={() => void controls.reconcile()}>{t("missions.scheduling.readReceipt")}</button></Show>}
          feedback={<>
            <p role="status">{status() ? t(status()!) : ""}</p>
            <Show when={controls.refusal()}>{refusal => <>
              <Show when={refusal().openable && refusal().configFileID}><button type="button" class="window-action"
                onClick={() => void openSettingsConfigFile(refusal().configFileID!)}>{t("missionsPanel.action.openSchedulingSettings")}</button></Show>
              <SettingsInfoTip text={`${t(refusal().layer === "environment" ? "missions.scheduleList.activationRefused.environment"
                : "missions.scheduleList.activationRefused.document", { layer: t(`missions.scheduleList.activationRefused.layer.${refusal().layer}`) })}${refusal().path ? `\n${refusal().path}` : ""}`} />
            </>}</Show>
          </>} />
        <dl class="mission-schedule-facts">
          <dt>{t("missions.scheduling.when")}</dt><dd><bdi>{criteria(doc())}</bdi></dd>
          <dt>{t("missions.scheduleList.desired")}</dt><dd>{t(`missions.scheduleList.state.${doc().state}`)}</dd>
          <dt>{t("missions.scheduleList.observed")}</dt><dd>{observed(doc())}</dd>
          <dt>{t(doc().observation.kind === "check" ? "missions.scheduleList.nextCheck" : "missions.scheduleList.nextWake")}<SettingsInfoTip text={t("missions.scheduleList.lateSlot")} /></dt><dd><bdi>{date(doc().observation.nextDueAt, zone())}</bdi></dd>
          <Show when={doc().slotEndsAt !== null || model().until !== null || model().endAfterMs !== null}>
            <dt>{t("missions.scheduling.until")}</dt><dd><bdi>{date(doc().slotEndsAt ?? model().until, zone())}</bdi>
              <Show when={doc().firstPlayedAt === null && model().endAfterMs !== null}> · {t("missions.scheduleList.endAfter", { minutes: String(model().endAfterMs! / 60_000) })}</Show></dd>
          </Show>
          <Show when={model().events.length}><dt>{t("missions.scheduleList.checks")}</dt><dd>{doc().checks ? `${doc().checks!.count} · ${t("missions.scheduleList.since", { when: date(doc().checks!.since) })}` : t("missions.scheduleList.unavailable")}</dd></Show>
          <dt>{t("missions.scheduleList.launched")}</dt><dd><bdi dir="ltr">{doc().launchedCount}<Show when={missionLaunchLimit(doc().configuration.launch)}>{limit => <> / {limit()}</>}</Show></bdi></dd>
          <dt>{t("missions.scheduleList.succeeded")}</dt><dd>{doc().successfulCount}</dd>
        </dl>
        <Show when={doc().blockReason}>{reason => <p role="status" class="mission-control-stale">
          {t("missions.scheduleList.blocked")} · {t(reason() === "deleting" ? "missions.scheduling.lock.deleted"
            : reason() === "failed" || reason() === "ended-without-report" ? "missions.recurrence.interruptedError" : "missions.scheduling.lock.uncertain")}
          <code><bdi>{reason()}</bdi></code>
        </p>}</Show>
        <Show when={expanded()}><section class="mission-schedule-instructions"><h3>{t("missions.control.objective")}</h3><p>{doc().configuration.objective}</p>
          <Show when={doc().configuration.notes}><p>{doc().configuration.notes}</p></Show></section></Show>
        <section class="mission-past-runs" aria-label={t("missionsPanel.pastRuns")}><h3>{t("missionsPanel.pastRuns")}</h3>
          <Show when={doc().history.length} fallback={<p>{t("missionsPanel.schedule.noRuns")}</p>}><ol><For each={[...doc().history].reverse()}>{item => <li>
            <span>{date(item.dueAt)} · {t(`missionsPanel.run.${item.reason === "not-started" ? "not-started" : item.outcome}`)}</span>
            <button type="button" class="window-action" onClick={() => props.onOpenConversation(item.coordinatorSessionID)}>{t("missionsPanel.action.openConversation")}</button>
          </li>}</For></ol></Show>
        </section>
        <MissionScheduleDiagnostics document={doc()} />
        {props.tracking}
      </section>
    }}</Show>
  </>
  const ownsSession = (sessionID: string) => schedules().some(doc => doc.id === props.selected
    && (doc.pendingPassage?.coordinatorSessionID === sessionID || doc.history.some(item => item.coordinatorSessionID === sessionID)))
  const markRead = (key: string) => {
    const doc = schedules().find(item => key === `scheduled:${item.id}`), result = doc?.latestResult, scope = seenScope()
    return doc && result?.outcome === "completed" && !scheduleSuccessSeen(scope, "scheduled", doc.id, result.id)
      ? () => markScheduleSuccessSeen(scope, "scheduled", doc.id, result.id) : undefined
  }
  return { entries, view, listView, refresh, ownsSession, loading: list.loading,
    next: list.next, more: list.more, retry: list.refresh, error: list.error, markRead,
    representation: (id: string) => list.error() || list.loading() || !list.fresh(id) ? undefined : list.rows().find(row => row.id === id)?.kind }
}
