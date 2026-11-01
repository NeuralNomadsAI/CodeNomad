import { For, Show } from "solid-js"
import { useI18n } from "../lib/i18n"
import type { UnifiedMissionSchedule } from "../stores/mission-schedules"
import { MissionDisclosure } from "./mission-disclosure"
import { SettingsInfoTip } from "./settings/settings-info-tip"

/** Document-owned identifiers only: technical carriers have no composer/navigation action. */
export function MissionScheduleDiagnostics(props: { document: UnifiedMissionSchedule }) {
  const { t } = useI18n()
  return <MissionDisclosure missionId={props.document.id} name="schedule-technical" defaultOpen={false}
    title={t("missions.scheduleDiagnostics.title")} class="mission-schedule-diagnostics"
    actions={<SettingsInfoTip text={`${t("missions.scheduleDiagnostics.cost")} ${t("missions.scheduleDiagnostics.retention")}`} />}>
    <p>{t("missions.scheduleDiagnostics.wakes", { count: props.document.observation.wakeCount ?? t("missions.scheduleList.unavailable") })}</p>
    <p role="status">{t(props.document.technical.cleanupPending ? "missions.scheduleDiagnostics.cleanupPending" : "missions.scheduleDiagnostics.cleanupClear")}</p>
    <Show when={props.document.technical.carriers.length} fallback={<p>{t("missions.scheduleDiagnostics.noCarriers")}</p>}>
      <ul><For each={props.document.technical.carriers}>{carrier => <li>
        <p>{t(`missions.scheduleDiagnostics.role.${carrier.role}`, { number: carrier.slot + 1 })}
          {" · "}{t("missions.scheduleDiagnostics.generation", { number: carrier.timeGeneration })}
          <Show when={carrier.retiring}> · {t(carrier.cleanupPending ? "missions.scheduleDiagnostics.cleanupPending" : "missions.scheduleDiagnostics.retired")}</Show></p>
        <p>{t("missions.scheduleDiagnostics.session")} · <code><bdi dir="ltr">{carrier.sessionID}</bdi></code></p>
        <p>{t("missions.scheduleDiagnostics.calendar")} · <code><bdi dir="ltr">{carrier.scheduleID ?? t("missions.scheduleList.none")}</bdi></code></p>
      </li>}</For></ul>
    </Show>
  </MissionDisclosure>
}
