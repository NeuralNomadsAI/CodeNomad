import { For, Show, createMemo } from "solid-js"
import { ArrowUpRight } from "lucide-solid"
import type { MissionActorActivity, MissionMap, MissionReport, MissionTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { updateMissionProjectView } from "../stores/mission-view-state"
import { MissionExecution } from "./mission-execution"
import { MissionNativeExecution, MissionReportNotification } from "./mission-native-execution"
import { missionTaskStatusKey } from "./mission-native-execution-model"
import { MissionReaderSection } from "./mission-reader"
import { missionTaskConversation } from "./mission-task-navigation"
import type { MissionObservedFamily } from "./mission-attention-model"

/** Read-only task facts; dependency navigation changes only this window's reader target. */
export function MissionTaskReader(props: {
  instanceId: string; scope: string; mission: MissionMap; task: MissionTask
  identity: string; activity?: MissionActorActivity["state"]
  family?: MissionObservedFamily
  onOpenActor: (sessionId: string) => Promise<void>
}) {
  const { t } = useI18n()
  const conversation = () => missionTaskConversation(props.mission, props.task, props.family)
  const byKey = (key: string) => props.mission.tasks.find(task => task.key === key)
  const navigate = (key: string) => {
    const task = byKey(key)
    if (task) updateMissionProjectView(props.scope, { reader: { missionId: props.mission.id, kind: "task", itemId: task.id } })
  }
  const link = (key: string, label: string) => <button type="button" class="mission-task-link" disabled={!byKey(key)}
    onClick={() => navigate(key)}>{t(label, { tasks: byKey(key)?.title ?? key, task: byKey(key)?.title ?? key })}</button>
  const latest = createMemo<MissionReport | undefined>(() => {
    const reports = [...props.mission.reports.filter(report => report.taskKey === props.task.key),
      ...(props.task.report ? [props.task.report] : []), ...(props.task.lateReports ?? [])]
    return reports.reduce<MissionReport | undefined>((latest, report) => !latest || report.createdAt >= latest.createdAt ? report : latest, undefined)
  })
  const sections = createMemo(() => {
    const report = latest()
    return report ? [
      { label: "missions.control.summary", text: report.summary },
      { label: "missions.control.report.evidence", text: report.evidence.join("\n\n") },
      { label: "missions.control.report.next", text: report.next.join("\n\n") },
      { label: "missions.control.artifact", text: report.artifact !== undefined ? JSON.stringify(report.artifact, null, 2) : "", raw: true },
    ] : []
  })
  return <div class="mission-task-reader" data-task-id={props.task.id}>
    <MissionReaderSection label="missions.control.brief" text={props.task.brief} identity={props.identity} instanceId={props.instanceId} />
    <Show when={props.task.executionMode?.kind === "independent" ? props.task.executionMode.explanation : undefined}>{text =>
      <MissionReaderSection label="missions.control.notes" text={text()} identity={props.identity} instanceId={props.instanceId} />
    }</Show>
    <article aria-label={t("missions.control.task.details")}>
      <h3>{t("missions.control.task.details")}</h3>
      <div class="mission-route-meta"><code>{props.task.key}</code><span>{props.task.role}</span>
        <span>{t(missionTaskStatusKey(props.task))}</span></div>
      <Show when={props.task.replacesTaskKey}>{key => <div><h4>{t("missions.control.history.before")}</h4>
        <button type="button" class="mission-task-link" disabled={!byKey(key())} onClick={() => navigate(key())}>{byKey(key())?.title ?? key()}</button></div>}</Show>
      <Show when={props.task.replacedByTaskKey}>{key => link(key(), "missions.control.task.replacedBy")}</Show>
      <Show when={props.task.status === "withdrawn" && props.task.outstandingExecution}><p role="status">{t("missions.control.task.retiredRunning")}</p></Show>
      <div class="mission-task-dependencies">
        <For each={props.task.blockedBy}>{key => link(key, "missions.control.task.blockedBy")}</For>
        <For each={props.mission.tasks.filter(task => task.blockedBy.includes(props.task.key))}>{task => link(task.key, "missions.control.task.blocks")}</For>
      </div>
    </article>
    <article aria-label={t("missions.control.execution.title")}>
      <h3>{t("missions.control.execution.title")}</h3>
      <MissionExecution instanceId={props.instanceId} task={props.task} />
      <MissionNativeExecution task={props.task} activity={props.activity} />
      <button type="button" class="mission-inline-session"
        onClick={() => void props.onOpenActor(conversation())}>
        <span>{conversation() === props.mission.coordinatorSessionId ? t("missions.control.openCoordinator")
          : t("missions.control.attention.openActor", { actor: props.mission.actors.find(actor => actor.sessionId === conversation())?.title ?? conversation() })}</span>
        <ArrowUpRight class="h-3 w-3" aria-hidden="true" />
      </button>
    </article>
    <Show when={latest()}>{report => <>
      <article aria-label={t("missions.control.native.business")}>
        <h3>{t("missions.control.native.business")}</h3>
        <p>{t(`missions.control.report.outcome.${report().outcome}`)}</p>
        <Show when={report().late}><p>{t("missions.control.report.late")}</p></Show>
        <MissionReportNotification report={report()} />
      </article>
      <For each={sections().map(section => section.label)}>{label => {
        const section = () => sections().find(section => section.label === label)!
        return <Show when={section().text}><MissionReaderSection label={label} text={section().text} raw={section().raw}
          identity={`${props.identity}:${report().id}`} instanceId={props.instanceId} /></Show>
      }}</For>
    </>}</Show>
  </div>
}
