import { createEffect } from "solid-js"
import { demandMissionTaskSessions, missionDerivedTaskSession } from "../stores/mission-task-sessions"
import type { MissionActivityProjection, MissionMap } from "../../../server/src/api-types"
import type { MissionReaderTarget } from "../stores/mission-view-state"
import { MissionAttention } from "./mission-attention"
import { MissionTaskTree } from "./mission-task-tree"
import { missionTaskConversation } from "./mission-task-navigation"

/** Selected one-time Mission or exact admitted passage: open requests and the
 * dependency task tree. Prose stays in the reader, opened from the action bar. */
export function MissionTracking(props: {
  instanceId: string; mission: MissionMap; activity?: MissionActivityProjection
  active: boolean; disabled: boolean; readOnly?: boolean
  reading: (target: MissionReaderTarget) => boolean; read: (target: MissionReaderTarget) => void
  onOpenActor: (id: string, request?: { id: string; kind: "form" | "permission" }) => Promise<void>
  refresh: () => Promise<void>
}) {
  const observed = () => props.activity?.missions.find(value => value.missionId === props.mission.id)
  const target = (kind: MissionReaderTarget["kind"], itemId?: string): MissionReaderTarget => ({ missionId: props.mission.id, kind, itemId })
  // Native session.status invalidations regenerate the activity projection: its
  // generation paces rereads of the linked conversations' activity.
  createEffect(() => { if (props.active) demandMissionTaskSessions(props.instanceId, props.mission, props.activity?.generatedAt) })
  return <>
    <MissionAttention mission={props.mission} family={observed()?.family} instanceId={props.instanceId} onOpenActor={props.onOpenActor} />
    <MissionTaskTree mission={props.mission} instanceId={props.instanceId} activity={observed()?.actors}
      reading={task => props.reading(target("task", task.id))} onRead={task => props.read(target("task", task.id))}
      conversation={task => missionTaskConversation(props.mission, task, observed()?.family,
        missionDerivedTaskSession(props.instanceId, props.mission, task.key))}
      onOpenConversation={id => void props.onOpenActor(id)}
      disabled={props.disabled || !props.active || props.readOnly} onRecoveryAdmitted={props.readOnly ? undefined : props.refresh} />
  </>
}
