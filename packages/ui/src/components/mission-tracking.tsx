import { createEffect } from "solid-js"
import { Eye } from "lucide-solid"
import { demandMissionTaskSessions, missionDerivedTaskSession } from "../stores/mission-task-sessions"
import type { MissionActivityProjection, MissionMap } from "../../../server/src/api-types"
import type { MissionReaderTarget } from "../stores/mission-view-state"
import { useI18n } from "../lib/i18n"
import { MissionAttention } from "./mission-attention"
import { MissionTaskTree } from "./mission-task-tree"
import { missionTaskConversation } from "./mission-task-navigation"

/** "Summary" toggle: the result/briefing/objective opens in the central reader. */
export function MissionOverviewToggle(props: { reading: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  return <div class="mission-detail-header">
    <button type="button" class="window-text-button icon-toggle mission-overview-toggle" aria-pressed={props.reading}
      onClick={() => props.onToggle()}><Eye class="h-3.5 w-3.5" aria-hidden="true" /><span>{t("missionsPanel.overview")}</span></button>
  </div>
}

/** Selected one-time Mission or exact admitted passage: open requests, the
 * overview toggle and the dependency task tree. Prose stays in the reader. */
export function MissionTracking(props: {
  instanceId: string; mission: MissionMap; activity?: MissionActivityProjection
  active: boolean; disabled: boolean; readOnly?: boolean
  reading: (target: MissionReaderTarget) => boolean; read: (target: MissionReaderTarget) => void
  onOpenActor: (id: string, request?: { id: string; kind: "form" | "permission" }) => Promise<void>
  refresh: () => Promise<void>
}) {
  const observed = () => props.activity?.missions.find(value => value.missionId === props.mission.id)
  const target = (kind: MissionReaderTarget["kind"], itemId?: string): MissionReaderTarget => ({ missionId: props.mission.id, kind, itemId })
  createEffect(() => { if (props.active) demandMissionTaskSessions(props.instanceId, props.mission) })
  return <>
    <MissionAttention mission={props.mission} family={observed()?.family} instanceId={props.instanceId} onOpenActor={props.onOpenActor} />
    <MissionOverviewToggle reading={props.reading(target("overview"))} onToggle={() => props.read(target("overview"))} />
    <MissionTaskTree mission={props.mission} instanceId={props.instanceId} activity={observed()?.actors}
      reading={task => props.reading(target("task", task.id))} onRead={task => props.read(target("task", task.id))}
      conversation={task => missionTaskConversation(props.mission, task, observed()?.family,
        missionDerivedTaskSession(props.instanceId, props.mission, task.key))}
      onOpenConversation={id => void props.onOpenActor(id)}
      disabled={props.disabled || !props.active || props.readOnly} onRecoveryAdmitted={props.readOnly ? undefined : props.refresh} />
  </>
}
