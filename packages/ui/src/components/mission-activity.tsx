import { For, Show, createMemo, createSignal } from "solid-js"
import type { MissionMap, MissionReport } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { MissionDisclosure } from "./mission-disclosure"
import { missionExcerpt, missionReportIsPrevious, missionReports } from "./mission-progress-model"

export function MissionActivity(props: { mission: MissionMap; onRead: (report: MissionReport) => void }) {
  const { t } = useI18n()
  const [history, setHistory] = createSignal<{ missionId: string; limit: number }>()
  const reports = createMemo(() => missionReports(props.mission))
  const limit = () => history()?.missionId === props.mission.id ? history()!.limit : 3
  const visible = () => reports().slice(0, limit())
  const task = (report: MissionReport) => props.mission.tasks.find(task => task.key === report.taskKey)
  return <Show when={reports().length}><MissionDisclosure missionId={props.mission.id} name="advances" title={t("missions.progress.advances")}>
    <Show when={reports().length} fallback={<p class="mission-control-empty-line">{t("missions.progress.noResults")}</p>}>
      <ol class="mission-advances"><For each={visible().map(report => report.id)}>{id => {
        const report = () => reports().find(report => report.id === id)!
        return <li><button type="button" onClick={() => props.onRead(report())} title={report().summary}>
          <time dateTime={new Date(report().createdAt).toISOString()}>{new Date(report().createdAt).toLocaleString()}</time>
          <strong>{task(report())?.title ?? (report().taskKey || t("missions.control.overview"))}</strong>
          <span class="mission-advance-summary">{missionExcerpt(report().summary)}</span>
          <small>{t(missionReportIsPrevious(props.mission, report())
            ? "missions.progress.previousAttempt" : `missions.control.report.outcome.${report().outcome}`)}</small>
        </button></li>
      }}</For></ol>
      <div class="window-actions">
        <Show when={reports().length > limit()}><button type="button" class="window-text-button"
          onClick={() => setHistory({ missionId: props.mission.id, limit: limit() + 10 })}>
          {t("missions.progress.fromStart")}
        </button></Show>
        <Show when={limit() > 3}><button type="button" class="window-text-button"
          onClick={() => setHistory({ missionId: props.mission.id, limit: 3 })}>
          {t("missions.progress.recentOnly")}
        </button></Show>
      </div>
    </Show>
  </MissionDisclosure></Show>
}
