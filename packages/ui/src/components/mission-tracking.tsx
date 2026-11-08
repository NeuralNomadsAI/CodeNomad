import { Show, createMemo } from "solid-js"
import { missionDerivedTaskSession, useMissionTaskSessionDemand } from "../stores/mission-task-sessions"
import type { MissionActivityProjection, MissionPanelMap } from "../../../server/src/api-types"
import type { MissionReaderTarget } from "../stores/mission-view-state"
import { MissionTaskTree } from "./mission-task-tree"
import { missionTaskConversation } from "./mission-task-navigation"
import { MissionPanelPaging } from "./mission-panel-paging"
import { useMissionPanelStore } from "./mission-panel-scope"
import { missionQuestions } from "./mission-questions"

/** Selected one-time Mission or exact admitted passage: the dependency task tree,
 * whose red tasks open their questions. Prose stays in the reader, opened from the
 * action bar. */
export function MissionTracking(props: {
  instanceId: string; mission: MissionPanelMap; activity?: MissionActivityProjection
  active: boolean
  reading: (target: MissionReaderTarget) => boolean; read: (target: MissionReaderTarget) => void
  onOpenActor: (id: string, request?: { id: string; kind: "form" | "permission" }) => Promise<void>
}) {
  const missionStore = useMissionPanelStore()
  const observed = () => props.activity?.missions.find(value => value.missionId === props.mission.id)
  const target = (kind: MissionReaderTarget["kind"], itemId?: string): MissionReaderTarget => ({ missionId: props.mission.id, kind, itemId })
  // Native lifecycle invalidations (session.execution.*, inbox, Shell, Form and
  // permission events) regenerate the activity projection: its generation paces
  // rereads of the linked conversations' activity.
  useMissionTaskSessionDemand({ instanceId: () => props.instanceId, mission: () => props.mission, active: () => props.active,
    pulse: () => props.activity?.generatedAt })
  const questions = createMemo(() => missionQuestions({ instanceId: props.instanceId, mission: props.mission, actors: props.mission.actors,
    family: observed()?.family, store: missionStore }))
  return <>
    <Show when={props.mission.panelCollections}>
      <MissionPanelPaging instanceId={props.instanceId} lane={`activity:${props.mission.id}`} actionsOnly />
    </Show>
    <MissionTaskTree mission={props.mission} instanceId={props.instanceId} activity={observed()?.actors} active={props.active}
      reading={task => props.reading(target("task", task.id))} onRead={task => props.read(target("task", task.id))}
      questions={questions()} onAnswer={(sessionId, request) => void props.onOpenActor(sessionId, request)}
      conversation={task => missionTaskConversation(props.mission, task, observed()?.family,
        missionDerivedTaskSession(props.instanceId, props.mission, task.key), [...props.mission.actors, ...missionStore.observedActors(props.instanceId, props.mission.id)])} />
  </>
}
