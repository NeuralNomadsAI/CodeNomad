import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js"
import type { MissionActorActivity, MissionPanelMap, MissionPanelReport, MissionPanelTask } from "../../../server/src/api-types"
import type { MissionReport, MissionTaskExecutionMode } from "../../../server/src/missions/model"
import { missionReportExcerpt } from "../../../server/src/missions/mission-panel-map"
import { missionOwnBody } from "../lib/mission-bodies"
import { useI18n } from "../lib/i18n"
import { updateMissionProjectView, type MissionReaderTarget } from "../stores/mission-view-state"
import { MissionExecution } from "./mission-execution"
import { MissionNativeExecution, MissionReportNotification } from "./mission-native-execution"
import { missionTaskStatusKey } from "./mission-native-execution-model"
import { MissionReaderSection } from "./mission-reader"
import { missionReports, missionTaskHistory, missionTaskReport } from "./mission-progress-model"
import type { MissionPassageSection } from "./mission-passage-section"
import type { MissionContentSelector } from "../../../server/src/missions/mission-content-wire"
import { MissionBodyPending, missionReaderBody, useReaderValue } from "./mission-reader-body"
import { openMissionTask } from "./mission-task-open"
import { MissionReportArtifact, MissionReportProse, useReportBodies } from "./mission-report-prose"

/** Read-only task facts; dependency navigation changes only this window's reader target. */
export function MissionTaskReader(props: {
  instanceId: string; scope: string; mission: MissionPanelMap; task: MissionPanelTask
  identity: string; activity?: MissionActorActivity["state"]
  recurrence?: MissionReaderTarget["recurrence"]
}) {
  const { t } = useI18n()
  const byKey = (key: string) => props.mission.tasks.find(task => task.key === key)
  // A one-time mission's compact map holds a page of its tasks: one not held is read by key.
  const paged = () => Boolean(props.mission.taskPage) && !props.recurrence
  const navigate = (key: string) => void openMissionTask(props.instanceId, props.scope, () => props.mission, key, props.recurrence)
  const link = (key: string, label: string) => <button type="button" class="mission-task-link" disabled={!byKey(key) && !paged()}
    onClick={() => navigate(key)}>{t(label, { tasks: byKey(key)?.title ?? key, task: byKey(key)?.title ?? key })}</button>
  const latest = createMemo<MissionPanelReport | undefined>(() => missionTaskReport(props.mission, props.task))
  // A compact row holds its newest reports and counts them all; Show all reads them whole.
  // Another task, never another copy of this one (a refresh), folds the history again.
  const [allHistory, setAllHistory] = createSignal(false)
  const taskKey = createMemo(() => props.task.key)
  createEffect(on(taskKey, () => setAllHistory(false), { defer: true }))
  const loadedReports = () => missionReports(props.mission).filter(report => report.taskKey === props.task.key).length
  const omittedHistory = () => paged() ? Math.max(0, (props.task.reportCount ?? 0) - loadedReports()) : 0
  const wholeHistory = useReaderValue<MissionReport[]>({ instanceId: () => props.instanceId, mission: () => props.mission, oneTime: () => !props.recurrence,
    active: allHistory, selector: () => allHistory() ? { kind: "task", taskKey: props.task.key, field: "reports" } : undefined })
  const history = createMemo((): MissionPanelReport[] => {
    const whole = allHistory() && wholeHistory.settled() ? wholeHistory.value() : undefined
    return whole ? [...whole].filter(report => report.id !== latest()?.id).sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      : missionTaskHistory(props.mission, props.task)
  })
  // Dependents of this task its map's page does not hold.
  const omittedDependents = () => paged() && props.task.status !== "completed"
    ? Math.max(0, (props.task.dependents ?? 0) - props.mission.tasks.filter(task => task.blockedBy.includes(props.task.key)).length) : 0
  const readout = createMemo(() => missionReports(props.mission).find(report => report.taskKey === props.task.key && !report.late
    && report.delivery === "coordinator-readout"))
  // A merging replacement names one predecessor; every retired task pointing to it is listed.
  const predecessors = createMemo(() => [...new Set([...(props.task.replacesTaskKey ? [props.task.replacesTaskKey] : []),
    ...props.mission.tasks.filter(task => task.replacedByTaskKey === props.task.key).map(task => task.key)])])
  // Once a task is done, the tasks it unblocked need no pointer.
  const unblocks = createMemo(() => props.task.status === "completed" ? []
    : props.mission.tasks.filter(task => task.blockedBy.includes(props.task.key) && task.status !== "withdrawn" && !task.replacedByTaskKey))
  // A one-time mission's bodies come from the content route, a disclosure's only while open; a passage's from its own map.
  const oneTime = () => !props.recurrence
  const briefSelector = (): MissionContentSelector => ({ kind: "task", taskKey: props.task.key, field: "brief" })
  const [briefOpen, setBriefOpen] = createSignal(false)
  const [technicalOpen, setTechnicalOpen] = createSignal(false)
  // An independent mode's explanation (never empty), read whole with its mode.
  const independent = () => props.task.executionMode?.kind === "independent"
  const executionMode = useReaderValue<MissionTaskExecutionMode>({ instanceId: () => props.instanceId, mission: () => props.mission, oneTime,
    active: technicalOpen, selector: () => independent() ? { kind: "task", taskKey: props.task.key, field: "executionMode" } : undefined })
  const explanation = (mode: MissionTaskExecutionMode | undefined) => mode?.kind === "independent" ? mode.explanation : ""
  // The coordinator's readout shows only for a task completed without its own report.
  const readoutBodies = useReportBodies({ instanceId: () => props.instanceId, mission: () => props.mission, oneTime,
    report: () => !latest() && props.task.status === "completed" ? readout() : undefined })
  const source = (section: MissionPassageSection["section"], report?: MissionPanelReport): MissionPassageSection | undefined => {
    const owner = props.recurrence
    return owner ? { scheduleID: owner.scheduleID, passageID: owner.passageID, projectID: owner.projectID,
      missionID: props.mission.id, revision: props.mission.revision, kind: report ? "report" : "task",
      itemId: report?.id ?? props.task.id, section } : undefined
  }
  const reportSource = (label: string, report: MissionPanelReport) => source(label.split(".").at(-1) as MissionPassageSection["section"], report)
  return <div class="mission-task-reader" data-task-id={props.task.id}>
    <Show when={latest()} fallback={<Show when={props.task.status === "completed"} fallback={<>
      <Show when={props.task.status === "blocked" || props.task.status === "needs-input"}>
        <p>{t(props.task.status === "needs-input" ? "missions.progress.obstacle" : missionTaskStatusKey(props.task))}</p>
      </Show>
      <p>{t("missions.progress.noTaskResult")}</p>
    </>}>
      {/* Completed without its own report: say so plainly, with the coordinator's readout when one exists. */}
      <p>{t("missionsPanel.task.done")}</p>
      <Show when={readout()}>{report => <MissionReaderSection label="missionsPanel.task.readout" text={readoutBodies.summary().text}
        body={readoutBodies.summary().body} read={readoutBodies.summary().read}
        identity={`${props.identity}:${report().id}`} instanceId={props.instanceId} source={reportSource("missions.control.summary", report())} />}</Show>
    </Show>}>{report => <>
      <p>{t(`missions.control.report.outcome.${report().outcome}`)}</p>
      <MissionReportProse instanceId={props.instanceId} mission={props.mission} report={report()} oneTime={oneTime()}
        identity={`${props.identity}:${report().id}`} source={label => reportSource(label, report())} />
    </>}</Show>
    <div class="mission-task-dependencies">
      <For each={props.task.blockedBy}>{key => link(key, "missions.control.task.blockedBy")}</For>
      <For each={unblocks()}>{task => link(task.key, "missionsPanel.task.unblocks")}</For>
      <Show when={props.task.replacedByTaskKey}>{key => link(key(), "missions.control.task.replacedBy")}</Show>
      <Show when={omittedDependents()}>{count => <p class="mission-task-omitted">
        {t(`missionsPanel.task.omittedDependents.${count() === 1 ? "one" : "other"}`, { count: count() })}</p>}</Show>
    </div>
    <Show when={history().length || omittedHistory()}>
      <section aria-label={t("missions.progress.previousResults")}>
        <h3>{t("missions.progress.previousResults")}</h3>
        <Show when={!allHistory() && omittedHistory()}>{count => <p class="mission-task-omitted">
          <span>{t(`missionsPanel.task.historyOmitted.${count() === 1 ? "one" : "other"}`, { count: count() })}</span>{" "}
          <button type="button" class="window-text-button" onClick={() => setAllHistory(true)}>{t("missionsPanel.task.showAllHistory")}</button></p>}</Show>
        <Show when={allHistory() && !wholeHistory.settled()}>
          <MissionBodyPending failed={wholeHistory.failed()} onRetry={wholeHistory.retry} /></Show>
        <For each={history().map(report => report.id)}>{id => {
          const report = () => history().find(report => report.id === id)!
          const [open, setOpen] = createSignal(false), [details, setDetails] = createSignal(false)
          return <details onToggle={event => setOpen(event.currentTarget.open)}>
            <summary>
              <span>{t(report().late ? "missions.control.report.late" : "missions.progress.previousAttempt")}</span>{" · "}
              <time dateTime={new Date(report().createdAt).toISOString()}>{new Date(report().createdAt).toLocaleString()}</time>
              <span class="mission-advance-summary">{missionReportExcerpt(report())}</span>
            </summary>
            <Show when={open()}>
              <p>{t(`missions.control.report.outcome.${report().outcome}`)}</p>
              <MissionReportProse instanceId={props.instanceId} mission={props.mission} report={report()} oneTime={oneTime()}
                identity={`${props.identity}:history:${id}`} source={label => reportSource(label, report())} />
              <details onToggle={event => setDetails(event.currentTarget.open)}><summary>{t("missions.control.task.details")}</summary>
                <MissionReportNotification report={report()} />
                <MissionReportArtifact instanceId={props.instanceId} mission={props.mission} report={report()} oneTime={oneTime()} active={details()}
                  identity={`${props.identity}:history:${id}`} source={source("artifact", report())} />
              </details>
            </Show>
          </details>
        }}</For>
      </section>
    </Show>
    <details onToggle={event => setBriefOpen(event.currentTarget.open)}><summary>{t("missions.control.brief")}</summary>
    <MissionReaderSection label="missions.control.brief" text={missionOwnBody<string>(props.mission, briefSelector())}
      body={missionReaderBody(props.instanceId, props.mission, oneTime(), briefSelector())}
      active={briefOpen()} identity={props.identity} instanceId={props.instanceId} source={source("brief")} />
    </details>
    <details onToggle={event => setTechnicalOpen(event.currentTarget.open)}><summary>{t("missions.control.task.details")}</summary>
    <Show when={independent()}>
      <MissionReaderSection label="missions.control.notes" text={executionMode.settled() ? explanation(executionMode.value()) : ""}
        read={executionMode.read()}
        identity={props.identity} instanceId={props.instanceId} source={source("notes")} />
    </Show>
    <article aria-label={t("missions.control.task.details")}>
      <h3>{t("missions.control.task.details")}</h3>
      <div class="mission-route-meta"><code>{props.task.key}</code><span>{props.task.role}</span>
        <span>{t(props.task.status === "needs-input" ? "missions.progress.obstacle" : missionTaskStatusKey(props.task))}</span></div>
      <Show when={predecessors().length}><div><h4>{t("missions.control.history.before")}</h4>
        <For each={predecessors()}>{key => <button type="button" class="mission-task-link" disabled={!byKey(key) && !paged()}
          onClick={() => navigate(key)}>{byKey(key)?.title ?? key}</button>}</For></div></Show>
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
      <MissionReportArtifact instanceId={props.instanceId} mission={props.mission} report={report()} oneTime={oneTime()} active={technicalOpen()}
        identity={`${props.identity}:${report().id}`} source={source("artifact", report())} />
    </>}</Show>
    </details>
  </div>
}
