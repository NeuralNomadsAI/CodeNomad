import { Show } from "solid-js"
import type { MissionActorActivity, MissionReport, MissionTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { missionActivityKey, missionNativeCallKey, missionReportNotificationKey } from "./mission-native-execution-model"

export function MissionReportNotification(props: { report: MissionReport }) {
  const { t } = useI18n()
  const notificationKey = () => missionReportNotificationKey(props.report)
  return <div class="mission-native-execution">
    <Show when={props.report.nativeCall}>{call => <small class="mission-native-note">
      {t("missions.control.native.reported")} <code dir="auto" title={`${t("missions.control.native.generation")}: ${call().generation} · ${call().parentSessionID} · ${call().parentMessageID} · ${call().toolCallID}`}>{call().toolCallID}</code>
    </small>}</Show>
    <Show when={props.report.delivery}><small class="mission-native-note">
      {t(props.report.delivery === "coordinator-readout" ? "missions.control.report.delivery.readout"
        : props.report.delivery === "native-return" ? "missions.control.report.delivery.nativeReturn" : "missions.control.report.delivery.coordinator")}
    </small></Show>
    <Show when={notificationKey()}>{key => <small class="mission-native-note" data-notification={props.report.notificationStatus ?? "unknown"}>
      {t(key())}
    </small>}</Show>
  </div>
}

/** Bounded scalar facts only, never a second execution queue or descendant transcript. */
export function MissionNativeExecution(props: { task: MissionTask; activity?: MissionActorActivity["state"] }) {
  const { t } = useI18n()
  const native = () => props.task.executionMode?.kind === "native" || Boolean(props.task.nativeBinding)
  const independent = () => props.task.executionMode?.kind === "independent" ? props.task.executionMode : undefined
  const invocation = () => props.task.nativeExecution
  const report = () => props.task.report ?? props.task.lateReports?.at(-1)
  return <Show when={native() || independent()}>
    <div class="mission-native-execution">
      <Show when={independent()}>{mode => <p class="mission-native-note">
        {t(`missions.control.native.independent.${mode().reason}`)} <span class="mission-text-excerpt" title={mode().explanation}>{mode().explanation}</span>
      </p>}</Show>
      <Show when={native()}>
        <dl class="mission-native-facts">
          <Show when={props.task.contractGeneration}>{generation => <div><dt>{t("missions.control.native.generation")}</dt><dd>{generation()}</dd></div>}</Show>
          <Show when={props.task.nativeBinding}>{binding => <div><dt>{t("missions.control.native.original")}</dt>
            <dd><code dir="auto" title={`${t("missions.control.native.generation")}: ${binding().generation} · ${binding().parentSessionID} · ${binding().parentMessageID} · ${binding().toolCallID}`}>{binding().toolCallID}</code></dd></div>}</Show>
          <div><dt>{t("missions.control.native.current")}</dt><dd>
            <Show when={invocation()} fallback={t("missions.control.execution.unknown")}>{current => <>
              <code dir="auto" title={`${t("missions.control.native.generation")}: ${current().binding.generation} · ${current().binding.parentSessionID} · ${current().binding.parentMessageID} · ${current().binding.toolCallID}`}>{current().binding.toolCallID}</code>
              <span>{t(missionNativeCallKey(props.task))}</span>
            </>}</Show>
          </dd></div>
          <div><dt>{t("missions.control.activity.title")}</dt><dd>{t(missionActivityKey(props.activity, true))}</dd></div>
          <div><dt>{t("missions.control.native.business")}</dt><dd>{t(report()
            ? `missions.control.report.outcome.${report()!.outcome}` : "missions.control.native.reportMissing")}
            <Show when={report()?.late}><small>{t("missions.control.report.late")}</small></Show>
          </dd></div>
        </dl>
        <p class="mission-native-note">{t("missions.control.native.separate")}</p>
      </Show>
    </div>
  </Show>
}
