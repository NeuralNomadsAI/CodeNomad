import { For, Show, createMemo, createSignal } from "solid-js"
import type { MissionMap, MissionReport } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { MissionDisclosure } from "./mission-disclosure"
import { missionExcerpt, missionReportIsPrevious, missionReports } from "./mission-progress-model"
import { MissionListItem } from "./mission-list-item"
import { Eye } from "lucide-solid"

export function MissionActivity(props: { mission: MissionMap; onRead: (report: MissionReport) => void; reading?: (report: MissionReport) => boolean }) {
  const { t, locale } = useI18n()
  const [history, setHistory] = createSignal<{ missionId: string; limit: number }>()
  const reports = createMemo(() => missionReports(props.mission))
  const limit = () => history()?.missionId === props.mission.id ? history()!.limit : 3
  const visible = () => reports().slice(0, limit())
  const task = (report: MissionReport) => props.mission.tasks.find(task => task.key === report.taskKey)
  return <Show when={reports().length}><MissionDisclosure missionId={props.mission.id} name="reports" defaultOpen={false} title={t("missions.control.reports.title")}>
    <Show when={reports().length} fallback={<p class="mission-control-empty-line">{t("missions.progress.noResults")}</p>}>
      <ol class="mission-advances"><For each={visible().map(report => report.id)}>{id => {
        const report = () => reports().find(report => report.id === id)!
        return <li><MissionListItem
          text={<>{task(report())?.title ?? (report().taskKey || t("missions.control.overview"))}{" — "}{missionExcerpt(report().summary)}</>}
          title={report().summary}
          status={<><time dateTime={new Date(report().createdAt).toISOString()}>{new Date(report().createdAt).toLocaleString(locale())}</time>{" · "}
            {t(missionReportIsPrevious(props.mission, report()) ? "missions.progress.previousAttempt" : `missions.control.report.outcome.${report().outcome}`)}</>}
          statusKind={missionReportIsPrevious(props.mission, report()) ? "withdrawn" : report().outcome}
          actions={[{ key: "read", label: t("missions.control.read"), checked: props.reading?.(report()) ?? false,
            icon: <Eye class="h-3.5 w-3.5" />, onSelect: () => props.onRead(report()) }]} />
        </li>
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
