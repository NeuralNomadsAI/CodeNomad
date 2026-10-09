import { Show, type JSX } from "solid-js"
import type { MissionActivityProjection, MissionMap, MissionReport } from "../../../server/src/api-types"
import type { MissionReaderTarget } from "../stores/mission-view-state"
import { sessions } from "../stores/sessions"
import { useI18n } from "../lib/i18n"
import { MissionAttention } from "./mission-attention"
import { MissionLifecycleControls } from "./mission-lifecycle-controls"
import { MissionBriefing } from "./mission-briefing"
import { MissionProgress } from "./mission-progress"
import { MissionWork } from "./mission-work"
import { MissionGuidance } from "./mission-guidance"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionActivity } from "./mission-activity"
import { MissionActors } from "./mission-actors"
import { MissionHistory } from "./mission-history"

/** The same tracking surface for one-shot Missions and exact admitted passages. */
export function MissionTracking(props: {
  instanceId: string; mission: MissionMap; activity?: MissionActivityProjection; activeSessionId: string | null
  active: boolean; disabled: boolean; messagingDisabled: boolean; readOnly?: boolean
  reading: (target: MissionReaderTarget) => boolean; read: (target: MissionReaderTarget) => void
  onOpenActor: (id: string, request?: { id: string; kind: "form" | "permission" }) => Promise<void>
  refresh: () => Promise<void>
  /** Appended to the single Technical details disclosure (a passage's schedule identity). */
  details?: JSX.Element
}) {
  const { t } = useI18n()
  const observed = () => props.activity?.missions.find(value => value.missionId === props.mission.id)
  const target = (kind: MissionReaderTarget["kind"], itemId?: string): MissionReaderTarget => ({ missionId: props.mission.id, kind, itemId })
  const reportTarget = (report: MissionReport) => {
    const task = props.mission.tasks.find(task => task.report?.id === report.id)
    return !props.mission.reports.some(item => item.id === report.id) && task ? target("task", task.id) : target("report", report.id)
  }
  return <>
    <MissionAttention mission={props.mission} family={observed()?.family} instanceId={props.instanceId} onOpenActor={props.onOpenActor} />
    <Show when={!props.readOnly}><MissionLifecycleControls instanceId={props.instanceId} mission={props.mission} disabled={props.disabled} /></Show>
    <MissionBriefing instanceId={props.instanceId} mission={props.mission} active={props.active} readOnly={props.readOnly}
      reading={props.reading(target("overview"))} disabled={props.messagingDisabled}
      onOpenCoordinator={() => void props.onOpenActor(props.mission.coordinatorSessionId)} onReadOverview={() => props.read(target("overview"))} />
    <MissionProgress mission={props.mission} activity={observed()?.actors} observedAt={props.activity?.generatedAt}
      onOpenActor={props.onOpenActor} />
    <Show when={props.mission.tasks.length}><MissionWork mission={props.mission} instanceId={props.instanceId}
      activeSessionId={props.activeSessionId} reading={task => props.reading(target("task", task.id))}
      family={observed()?.family} activity={observed()?.actors} disabled={props.disabled || !props.active || props.readOnly}
      onRecoveryAdmitted={props.readOnly ? undefined : props.refresh} onOpenActor={props.onOpenActor}
      onRead={task => props.read(target("task", task.id))} onReport={report => props.read(target("report", report.id))} /></Show>
    <Show when={!props.readOnly && props.mission.status === "active"}>
      <MissionGuidance instanceId={props.instanceId} mission={props.mission} active={props.active} mode="question"
        disabled={props.messagingDisabled} onOpenCoordinator={() => void props.onOpenActor(props.mission.coordinatorSessionId)} />
      <MissionGuidance instanceId={props.instanceId} mission={props.mission} active={props.active} disabled={props.messagingDisabled} />
    </Show>
    <MissionDisclosure missionId={props.mission.id} name="details" defaultOpen={false} title={t("missions.control.task.details")}>
      <MissionActivity mission={props.mission} onRead={report => props.read(reportTarget(report))} reading={report => props.reading(reportTarget(report))} />
      <Show when={props.mission.status === "active" && props.mission.reports.some(report => report.notificationStatus === "pending" && report.delivery !== "native-return")}>
        <p class="mission-control-stale" role="status">{t("missions.control.report.notificationPending")}</p>
      </Show>
      <MissionActors mission={props.mission} instanceId={props.instanceId} activity={observed()?.actors} family={observed()?.family}
        sessionTitle={id => sessions().get(props.instanceId)?.get(id)?.title ?? id} activeSessionId={props.activeSessionId}
        onOpenActor={props.onOpenActor} t={t} />
      <MissionHistory mission={props.mission} reading={revision => props.reading(target("change", String(revision)))}
        onRead={revision => props.read(target("change", String(revision)))} />
      {props.details}
    </MissionDisclosure>
  </>
}
