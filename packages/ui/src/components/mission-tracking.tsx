import { Show, type JSX } from "solid-js"
import type { MissionActivityProjection, MissionMap, MissionReport } from "../../../server/src/api-types"
import type { MissionReaderTarget } from "../stores/mission-view-state"
import { sessions } from "../stores/sessions"
import { useI18n } from "../lib/i18n"
import { missionAcceptsMessage } from "../lib/mission-coordinator-message"
import { MissionAttention } from "./mission-attention"
import { createMissionBriefingRequest } from "./mission-briefing"
import { MissionResult } from "./mission-result"
import { MissionTaskChecklist } from "./mission-task-checklist"
import { MissionWork } from "./mission-work"
import { MissionGuidance } from "./mission-guidance"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionActivity } from "./mission-activity"
import { MissionActors } from "./mission-actors"
import { MissionHistory } from "./mission-history"
import { MissionProfileSummary } from "./mission-profile-summary"

/** One card for one-shot Missions and exact admitted passages: Needs you,
 * Result, Tasks, the coordinator field and a single collapsed More. */
export function MissionTracking(props: {
  instanceId: string; mission: MissionMap; activity?: MissionActivityProjection; activeSessionId: string | null
  active: boolean; disabled: boolean; messagingDisabled: boolean; readOnly?: boolean
  reading: (target: MissionReaderTarget) => boolean; read: (target: MissionReaderTarget) => void
  onOpenActor: (id: string, request?: { id: string; kind: "form" | "permission" }) => Promise<void>
  refresh: () => Promise<void>
  /** Appended to the technical details inside More (a passage's schedule identity). */
  details?: JSX.Element
  /** Further secondary sections inside More (past passages, cleanup history). */
  more?: JSX.Element
}) {
  const { t } = useI18n()
  const observed = () => props.activity?.missions.find(value => value.missionId === props.mission.id)
  const target = (kind: MissionReaderTarget["kind"], itemId?: string): MissionReaderTarget => ({ missionId: props.mission.id, kind, itemId })
  const reportTarget = (report: MissionReport) => {
    const task = props.mission.tasks.find(task => task.report?.id === report.id)
    return !props.mission.reports.some(item => item.id === report.id) && task ? target("task", task.id) : target("report", report.id)
  }
  const briefing = createMissionBriefingRequest({
    get instanceId() { return props.instanceId }, get mission() { return props.mission }, get active() { return props.active },
    get disabled() { return props.messagingDisabled }, get readOnly() { return props.readOnly },
  })
  const openCoordinator = () => void props.onOpenActor(props.mission.coordinatorSessionId)
  return <>
    <MissionAttention mission={props.mission} family={observed()?.family} instanceId={props.instanceId} onOpenActor={props.onOpenActor} />
    <MissionResult mission={props.mission} reading={props.reading(target("overview"))} onReadAll={() => props.read(target("overview"))}
      feedback={briefing.feedback(openCoordinator)} />
    <MissionTaskChecklist mission={props.mission} instanceId={props.instanceId} activity={observed()?.actors}
      reading={task => props.reading(target("task", task.id))} onRead={task => props.read(target("task", task.id))}
      disabled={props.disabled || !props.active || props.readOnly} onRecoveryAdmitted={props.readOnly ? undefined : props.refresh} />
    <Show when={!props.readOnly && missionAcceptsMessage(props.mission)}>
      <MissionGuidance instanceId={props.instanceId} mission={props.mission} active={props.active} disabled={props.messagingDisabled} />
    </Show>
    <MissionDisclosure missionId={props.mission.id} name="more" defaultOpen={false} class="mission-more" title={t("missionsPanel.more")}>
      <MissionActors mission={props.mission} instanceId={props.instanceId} activity={observed()?.actors} family={observed()?.family}
        sessionTitle={id => sessions().get(props.instanceId)?.get(id)?.title ?? id} activeSessionId={props.activeSessionId}
        onOpenActor={props.onOpenActor} t={t} />
      <MissionHistory mission={props.mission} reading={revision => props.reading(target("change", String(revision)))}
        onRead={revision => props.read(target("change", String(revision)))} />
      <MissionActivity mission={props.mission} onRead={report => props.read(reportTarget(report))} reading={report => props.reading(reportTarget(report))} />
      <Show when={props.mission.status === "active" && props.mission.reports.some(report => report.notificationStatus === "pending" && report.delivery !== "native-return")}>
        <p class="mission-control-stale" role="status">{t("missions.control.report.notificationPending")}</p>
      </Show>
      {props.more}
      <MissionDisclosure missionId={props.mission.id} name="details" defaultOpen={false} title={t("missionsPanel.technical")}>
        <dl class="mission-technical">
          <dt>{t("missionsPanel.technical.mission")}</dt><dd><bdi>{props.mission.id}</bdi></dd>
          <dt>{t("missionsPanel.technical.coordinator")}</dt><dd><bdi>{props.mission.coordinatorSessionId}</bdi></dd>
          {props.details}
        </dl>
        <MissionProfileSummary profiles={props.mission.profiles} template={props.mission.template} />
      </MissionDisclosure>
      <Show when={props.mission.tasks.some(task => task.blockedBy.length)}>
        <MissionWork mission={props.mission} instanceId={props.instanceId}
          activeSessionId={props.activeSessionId} reading={task => props.reading(target("task", task.id))}
          family={observed()?.family} activity={observed()?.actors} disabled={props.disabled || !props.active || props.readOnly}
          onRecoveryAdmitted={props.readOnly ? undefined : props.refresh} onOpenActor={props.onOpenActor}
          onRead={task => props.read(target("task", task.id))} onReport={report => props.read(target("report", report.id))} />
      </Show>
    </MissionDisclosure>
  </>
}
