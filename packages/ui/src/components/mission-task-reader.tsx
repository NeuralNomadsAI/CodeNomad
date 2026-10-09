import { For, Show, createMemo, createSignal } from "solid-js"
import type { MissionActorActivity, MissionMap, MissionReport, MissionTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { updateMissionProjectView, type MissionReaderTarget } from "../stores/mission-view-state"
import { MissionExecution } from "./mission-execution"
import { MissionNativeExecution, MissionReportNotification } from "./mission-native-execution"
import { missionTaskStatusKey } from "./mission-native-execution-model"
import { MissionReaderSection } from "./mission-reader"
import { missionExcerpt, missionReports, missionTaskHistory, missionTaskReport } from "./mission-progress-model"
import type { MissionPassageSection } from "./mission-passage-section"

/** Read-only task facts; dependency navigation changes only this window's reader target. */
export function MissionTaskReader(props: {
  instanceId: string; scope: string; mission: MissionMap; task: MissionTask
  identity: string; activity?: MissionActorActivity["state"]
  recurrence?: MissionReaderTarget["recurrence"]
}) {
  const { t } = useI18n()
  const byKey = (key: string) => props.mission.tasks.find(task => task.key === key)
  const navigate = (key: string) => {
    const task = byKey(key)
    if (task) updateMissionProjectView(props.scope, { reader: { missionId: props.mission.id, kind: "task", itemId: task.id, recurrence: props.recurrence } })
  }
  const link = (key: string, label: string) => <button type="button" class="mission-task-link" disabled={!byKey(key)}
    onClick={() => navigate(key)}>{t(label, { tasks: byKey(key)?.title ?? key, task: byKey(key)?.title ?? key })}</button>
  const latest = createMemo<MissionReport | undefined>(() => missionTaskReport(props.mission, props.task))
  const history = createMemo(() => missionTaskHistory(props.mission, props.task))
  const readout = createMemo(() => missionReports(props.mission).find(report => report.taskKey === props.task.key && !report.late
    && report.delivery === "coordinator-readout"))
  // Once a task is done, the tasks it unblocked need no pointer.
  const unblocks = createMemo(() => props.task.status === "completed" ? []
    : props.mission.tasks.filter(task => task.blockedBy.includes(props.task.key) && task.status !== "withdrawn" && !task.replacedByTaskKey))
  const sections = (report: MissionReport) => [
      { label: "missions.control.summary", text: report.summary },
      { label: "missions.control.report.next", text: report.next.join("\n\n") },
      { label: "missions.control.report.evidence", text: report.evidence.join("\n\n") },
    ]
  const source = (section: MissionPassageSection["section"], report?: MissionReport): MissionPassageSection | undefined => {
    const owner = props.recurrence
    return owner ? { scheduleID: owner.scheduleID, passageID: owner.passageID, projectID: owner.projectID,
      missionID: props.mission.id, revision: props.mission.revision, kind: report ? "report" : "task",
      itemId: report?.id ?? props.task.id, section } : undefined
  }
  const reportSource = (label: string, report: MissionReport) => source(label.split(".").at(-1) as MissionPassageSection["section"], report)
  return <div class="mission-task-reader" data-task-id={props.task.id}>
    <Show when={latest()} fallback={<Show when={props.task.status === "completed"} fallback={<>
      <Show when={props.task.status === "blocked" || props.task.status === "needs-input"}>
        <p>{t(props.task.status === "needs-input" ? "missions.progress.obstacle" : missionTaskStatusKey(props.task))}</p>
      </Show>
      <p>{t("missions.progress.noTaskResult")}</p>
    </>}>
      {/* Completed without its own report: say so plainly, with the coordinator's readout when one exists. */}
      <p>{t("missionsPanel.task.done")}</p>
      <Show when={readout()}>{report => <MissionReaderSection label="missionsPanel.task.readout" text={report().summary}
        identity={`${props.identity}:${report().id}`} instanceId={props.instanceId} source={reportSource("missions.control.summary", report())} />}</Show>
    </Show>}>{report => <>
      <p>{t(`missions.control.report.outcome.${report().outcome}`)}</p>
      <For each={sections(report()).map(section => section.label)}>{label => {
        const section = () => sections(report()).find(section => section.label === label)!
        return <Show when={section().text}><MissionReaderSection label={label} text={section().text}
          identity={`${props.identity}:${report().id}`} instanceId={props.instanceId} source={reportSource(label, report())} /></Show>
      }}</For>
    </>}</Show>
    <div class="mission-task-dependencies">
      <For each={props.task.blockedBy}>{key => link(key, "missions.control.task.blockedBy")}</For>
      <For each={unblocks()}>{task => link(task.key, "missionsPanel.task.unblocks")}</For>
      <Show when={props.task.replacedByTaskKey}>{key => link(key(), "missions.control.task.replacedBy")}</Show>
    </div>
    <Show when={history().length}>
      <section aria-label={t("missions.progress.previousResults")}>
        <h3>{t("missions.progress.previousResults")}</h3>
        <For each={history().map(report => report.id)}>{id => {
          const report = () => history().find(report => report.id === id)!
          const [open, setOpen] = createSignal(false)
          return <details onToggle={event => setOpen(event.currentTarget.open)}>
            <summary>
              <span>{t(report().late ? "missions.control.report.late" : "missions.progress.previousAttempt")}</span>{" · "}
              <time dateTime={new Date(report().createdAt).toISOString()}>{new Date(report().createdAt).toLocaleString()}</time>
              <span class="mission-advance-summary">{missionExcerpt(report().summary).slice(0, 180)}</span>
            </summary>
            <Show when={open()}>
              <p>{t(`missions.control.report.outcome.${report().outcome}`)}</p>
              <For each={sections(report()).map(section => section.label)}>{label => {
                const section = () => sections(report()).find(section => section.label === label)!
                return <Show when={section().text}><MissionReaderSection label={label} text={section().text}
                  identity={`${props.identity}:history:${id}`} instanceId={props.instanceId} source={reportSource(label, report())} /></Show>
              }}</For>
              <details><summary>{t("missions.control.task.details")}</summary>
                <MissionReportNotification report={report()} />
                <Show when={report().artifact !== undefined}><MissionReaderSection label="missions.control.artifact"
                  text={JSON.stringify(report().artifact, null, 2)} raw identity={`${props.identity}:history:${id}`}
                  instanceId={props.instanceId} source={source("artifact", report())} /></Show>
              </details>
            </Show>
          </details>
        }}</For>
      </section>
    </Show>
    <details><summary>{t("missions.control.brief")}</summary>
    <MissionReaderSection label="missions.control.brief" text={props.task.brief} identity={props.identity} instanceId={props.instanceId} source={source("brief")} />
    </details>
    <details><summary>{t("missions.control.task.details")}</summary>
    <Show when={props.task.executionMode?.kind === "independent" ? props.task.executionMode.explanation : undefined}>{text =>
      <MissionReaderSection label="missions.control.notes" text={text()} identity={props.identity} instanceId={props.instanceId} source={source("notes")} />
    }</Show>
    <article aria-label={t("missions.control.task.details")}>
      <h3>{t("missions.control.task.details")}</h3>
      <div class="mission-route-meta"><code>{props.task.key}</code><span>{props.task.role}</span>
        <span>{t(props.task.status === "needs-input" ? "missions.progress.obstacle" : missionTaskStatusKey(props.task))}</span></div>
      <Show when={props.task.replacesTaskKey}>{key => <div><h4>{t("missions.control.history.before")}</h4>
        <button type="button" class="mission-task-link" disabled={!byKey(key())} onClick={() => navigate(key())}>{byKey(key())?.title ?? key()}</button></div>}</Show>
      <Show when={props.task.status === "withdrawn" && props.task.outstandingExecution}><p role="status">{t("missions.control.task.retiredRunning")}</p></Show>
    </article>
    <article aria-label={t("missions.control.execution.title")}>
      <h3>{t("missions.control.execution.title")}</h3>
      <MissionExecution instanceId={props.instanceId} task={props.task} />
      <MissionNativeExecution task={props.task} activity={props.activity} />
    </article>
    <Show when={latest()}>{report => <>
      <article aria-label={t("missions.control.native.business")}>
        <h3>{t("missions.control.native.business")}</h3>
        <p>{t(`missions.control.report.outcome.${report().outcome}`)}</p>
        <Show when={report().late}><p>{t("missions.control.report.late")}</p></Show>
        <MissionReportNotification report={report()} />
      </article>
      <Show when={report().artifact !== undefined}><MissionReaderSection label="missions.control.artifact"
        text={JSON.stringify(report().artifact, null, 2)} raw identity={`${props.identity}:${report().id}`} instanceId={props.instanceId} source={source("artifact", report())} /></Show>
    </>}</Show>
    </details>
  </div>
}
