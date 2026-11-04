import { For, Show, createMemo, createSignal, createEffect, type JSX } from "solid-js"
import { useI18n } from "../lib/i18n"
import { useMissionSchedules, unifiedScheduleHold, type UnifiedMissionSchedule } from "../stores/mission-schedules"
import type { MissionPickerEntry } from "./mission-picker-model"
import { describeMissionCriteria, missionCriteriaZone } from "./mission-scheduling-summary"
import { createMissionScheduleControls } from "./mission-schedule-controls"
import { MissionActionBar } from "./mission-action-bar"
import { missionLaunchLimit, missionLaunchModel } from "../../../server/src/missions/mission-launch-kind"
import { MissionScheduleDiagnostics } from "./mission-schedule-diagnostics"
import { SettingsInfoTip } from "./settings/settings-info-tip"

export function createMissionScheduleList(props: { instanceId: string; projectID?: string; directory: string;
  active: () => boolean; enabled: () => boolean; refresh: number; selected?: string; detailId: string;
  onEdit: (id: string) => void; onDeleted: (id: string) => void; onOpenConversation: (id: string) => void;
  tracking?: JSX.Element; passage?: { reading: boolean; onToggle(): void }; onPassage?: (id: string | undefined) => void;
  selectedRequests?: { passageID: string; count: number } }) {
  const { t, locale } = useI18n()
  const [revision, setRevision] = createSignal(0)
  const list = useMissionSchedules({ instanceId: () => props.instanceId, projectID: () => props.projectID,
    directory: () => props.directory, active: props.active, refresh: () => props.refresh + revision(), selected: () => props.selected })
  const schedules = () => list.rows().filter(row => row.kind === "schedule")
  createEffect(() => props.onPassage?.(schedules().find(row => row.id === props.selected)?.pendingPassage ? props.selected : undefined))
  const date = (value: number | null, zone?: string) => value === null ? t("missions.scheduleList.none")
    : new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", ...(zone ? { timeZone: zone } : {}) }).format(value)
  const criteria = (doc: UnifiedMissionSchedule) => describeMissionCriteria(doc.configuration.launch, t, locale(), doc.oneShotAt).join("; ")
  const observed = (doc: UnifiedMissionSchedule) => t(`missions.scheduleList.observed.${doc.observation.state === "known"
    ? doc.observation.nativeStatus ?? "unknown" : doc.observation.state}`)
  const zoneOf = (doc: UnifiedMissionSchedule) => missionCriteriaZone(doc.configuration.launch)
  const nextWake = (doc: UnifiedMissionSchedule) => `${t(doc.observation.kind === "check" ? "missions.scheduleList.nextCheck" : "missions.scheduleList.nextWake")} · ${date(doc.observation.nextDueAt, zoneOf(doc))}`
  const entries = createMemo((): MissionPickerEntry[] => schedules().map(doc => ({ key: `scheduled:${doc.id}`,
    title: doc.configuration.title,
    mark: doc.id === props.selected && doc.pendingPassage?.id === props.selectedRequests?.passageID && (props.selectedRequests?.count ?? 0) > 0 ? "permission"
      : doc.blockReason ? "interrupted" : doc.pendingPassage ? "working" : doc.firstPlayedAt === null && doc.state === "paused" ? "prepared"
      : doc.state === "paused" ? "paused" : doc.state === "finished" ? "done" : "idle",
    status: [t(`missions.scheduleList.state.${doc.state}`),
      doc.id === props.selected && doc.pendingPassage?.id === props.selectedRequests?.passageID && (props.selectedRequests?.count ?? 0) > 0 ? t("missionsPanel.task.input") : "",
      criteria(doc), nextWake(doc)].filter(Boolean).join(" · ") })))
  const refresh = () => setRevision(value => value + 1)
  const publishing = () => unifiedScheduleHold(JSON.stringify([props.instanceId, props.projectID, props.directory, props.selected]))?.phase === "publication"
  const view = () => <>
    <Show when={list.error()}><p role="status" class="mission-control-stale">{t("missions.scheduleList.readFailed")}</p></Show>
    <Show when={list.selectionError()}>{error => <p class="mission-control-stale" role="status">
      {t(error() === "pending" ? publishing() ? "missions.scheduleList.confirmedRefreshing" : "missions.scheduleList.uncertain" : "missions.scheduleList.readFailed")}
    </p>}</Show>
    <Show when={list.next()}><button type="button" class="window-text-button" disabled={list.loading() || !props.active()}
      onClick={list.more}>{t("missions.scheduleList.more")}</button></Show>
    <Show when={props.selected && schedules().some(row => row.id === props.selected) ? props.selected : undefined} keyed>{id => {
      const doc = createMemo<UnifiedMissionSchedule>(previous => schedules().find(row => row.id === id) ?? previous!)
      const controls = createMissionScheduleControls({ get instanceId() { return props.instanceId }, get projectID() { return props.projectID },
        get directory() { return props.directory }, document: doc, active: props.active,
        enabled: () => props.enabled() && !list.error() && list.fresh(id), refreshVersion: () => props.refresh + revision(), refresh,
        onDeleted: () => props.onDeleted(id) })
      const [expanded, expand] = createSignal(false)
      const primary = () => (["pause", "resume", "play"] as const).find(action => doc().availableActions.includes(action))
      const action = (name: "play" | "resume" | "pause" | "stop" | "run-now") => ({ key: name, label: controls.label(name),
        disabled: !controls.capable(name), onSelect: () => controls.act(name) })
      const zone = () => zoneOf(doc()), model = createMemo(() => missionLaunchModel(doc().configuration.launch))
      const editable = () => props.active() && props.enabled() && !list.error() && list.fresh(id)
        && !controls.held() && !controls.busy() && doc().availableActions.includes("configure")
      return <section id={props.detailId} class="mission-detail mission-unified-schedule" aria-label={doc().configuration.title}>
        <MissionActionBar label={t("missionsPanel.picker.actions")} reading={props.passage?.reading ?? expanded()} onToggleReader={() => props.passage ? props.passage.onToggle() : expand(value => !value)}
          primary={primary() ? action(primary()!) : undefined} stop={action("stop")} runNow={action("run-now")}
          onEdit={() => { if (editable()) props.onEdit(id) }} editDisabled={!editable()}
          onDelete={() => void controls.act("delete")} deleteDisabled={!controls.capable("delete")}
          onOpenConversation={doc().pendingPassage ? () => props.onOpenConversation(doc().pendingPassage!.coordinatorSessionID) : undefined}
          secondary={<>
            <button type="button" class="window-text-button" disabled={!controls.capable("check")} onClick={() => void controls.act("check")}>{controls.label("check")}</button>
            <Show when={controls.held()}><button type="button" class="window-text-button" disabled={controls.busy()} onClick={() => void controls.reconcile()}>{t("missions.scheduling.readReceipt")}</button></Show>
          </>}
          feedback={<>
            <Show when={controls.held()}><p role="status">{t(controls.publishing() ? "missions.scheduleList.confirmedRefreshing" : "missions.scheduleList.uncertain")}</p></Show>
            <Show when={controls.feedback()}>{key => <p role="status">{t(key())}</p>}</Show>
            <Show when={controls.capability() === "missing"}><p role="status">{t("missions.scheduling.capability.missing")}</p></Show>
            <Show when={controls.capability() === "activatable"}><p role="status">{t("missions.scheduleList.runNowRequiresEnabled")}</p></Show>
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
            <button type="button" class="window-text-button" onClick={() => props.onOpenConversation(item.coordinatorSessionID)}>{t("missionsPanel.action.openConversation")}</button>
          </li>}</For></ol></Show>
        </section>
        <MissionScheduleDiagnostics document={doc()} />
        {props.tracking}
      </section>
    }}</Show>
  </>
  const ownsSession = (sessionID: string) => schedules().some(doc => doc.id === props.selected
    && (doc.pendingPassage?.coordinatorSessionID === sessionID || doc.history.some(item => item.coordinatorSessionID === sessionID)))
  return { entries, view, refresh, ownsSession, loading: list.loading,
    representation: (id: string) => list.error() || list.loading() || !list.fresh(id) ? undefined : list.rows().find(row => row.id === id)?.kind }
}
