import { For, Show, createMemo } from "solid-js"
import type { MissionMap, MissionReport } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { missionStore } from "../stores/missions"
import { updateMissionProjectView, type MissionReaderTarget } from "../stores/mission-view-state"
import { MissionCleanupPanel } from "./mission-cleanup"
import { MissionProfileSummary } from "./mission-profile-summary"
import { missionReportIsPrevious, missionReports } from "./mission-progress-model"

/** Secondary overview material, folded at the bottom of the central overview
 * reader: plan changes, reports, conversation cleanup history and identifiers.
 * The panel keeps none of it. */
export function MissionOverviewDetails(props: {
  instanceId: string; scope: string; mission: MissionMap; recurrence?: MissionReaderTarget["recurrence"]
}) {
  const { t, locale } = useI18n()
  const open = (kind: MissionReaderTarget["kind"], itemId: string) =>
    updateMissionProjectView(props.scope, { reader: { missionId: props.mission.id, kind, itemId, recurrence: props.recurrence } })
  const history = () => [...(props.mission.history ?? [])].reverse()
  const reports = createMemo(() => missionReports(props.mission))
  const reportTarget = (report: MissionReport) => {
    const task = props.mission.tasks.find(task => task.report?.id === report.id)
    return !props.mission.reports.some(item => item.id === report.id) && task ? { kind: "task" as const, id: task.id } : { kind: "report" as const, id: report.id }
  }
  const author = (actorSessionId?: string, source?: string) => source === "user" ? t("missions.control.history.user")
    : actorSessionId === props.mission.coordinatorSessionId ? t("missions.control.history.coordinator")
    : props.mission.actors.find(actor => actor.sessionId === actorSessionId)?.title ?? actorSessionId ?? ""
  const when = (at: number) => <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString(locale())}</time>
  const cleanups = () => props.recurrence ? [] : missionStore.state(props.instanceId).cleanups ?? []
  return <div class="mission-overview-details">
    <Show when={props.mission.status === "active" && props.mission.reports.some(report => report.notificationStatus === "pending" && report.delivery !== "native-return")}>
      <p role="status">{t("missions.control.report.notificationPending")}</p>
    </Show>
    <Show when={history().length}>
      <details class="mission-report-technical"><summary>{t("missions.control.history.title")}</summary>
        <Show when={props.mission.historyTruncated}><p>{t("missions.control.history.truncated", { count: history().length })}</p></Show>
        <ol class="mission-reader-links"><For each={history()}>{change => <li>
          <button type="button" class="window-text-button" onClick={() => open("change", String(change.revision))}>
            {change.reason ?? t("missions.control.edit")}</button>
          <small>{when(change.createdAt)} · {author(change.actorSessionId, change.source)}</small>
        </li>}</For></ol>
      </details>
    </Show>
    <Show when={reports().length}>
      <details class="mission-report-technical"><summary>{t("missions.control.reports.title")}</summary>
        <ol class="mission-reader-links"><For each={reports()}>{report => <li>
          <button type="button" class="window-text-button" onClick={() => { const target = reportTarget(report); open(target.kind, target.id) }}>
            {props.mission.tasks.find(task => task.key === report.taskKey)?.title ?? (report.taskKey || t("missions.control.overview"))}</button>
          <small>{when(report.createdAt)} · {t(missionReportIsPrevious(props.mission, report) ? "missions.progress.previousAttempt" : `missions.control.report.outcome.${report.outcome}`)}</small>
        </li>}</For></ol>
      </details>
    </Show>
    <Show when={cleanups().length}>
      <MissionCleanupPanel instanceId={props.instanceId} cleanups={cleanups()} active
        disabled={missionStore.state(props.instanceId).status !== "ready" || Boolean(missionStore.state(props.instanceId).cleanupUnavailable)}
        refresh={() => missionStore.refresh(props.instanceId)} />
    </Show>
    <details class="mission-report-technical"><summary>{t("missionsPanel.technical")}</summary>
      <dl class="mission-technical">
        <dt>{t("missionsPanel.technical.mission")}</dt><dd><bdi>{props.mission.id}</bdi></dd>
        <dt>{t("missionsPanel.technical.coordinator")}</dt><dd><bdi>{props.mission.coordinatorSessionId}</bdi></dd>
        <Show when={props.recurrence}>{owner => <>
          <dt>{t("missionsPanel.technical.schedule")}</dt><dd><bdi>{owner().scheduleID}</bdi></dd>
          <dt>{t("missionsPanel.technical.passage")}</dt><dd><bdi>{owner().passageID}</bdi></dd>
        </>}</Show>
      </dl>
      <MissionProfileSummary profiles={props.mission.profiles} template={props.mission.template} />
    </details>
  </div>
}
