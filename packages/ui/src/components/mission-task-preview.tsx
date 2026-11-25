import { Show, createEffect, createMemo, createUniqueId, onCleanup, untrack } from "solid-js"
import type { MissionActivityProjection, MissionPanelMap, MissionPanelTask } from "../../../server/src/api-types"
import { missionStore } from "../stores/missions"
import { useMissionCurrentPassage } from "../stores/mission-recurrence"
import { missionDerivedTaskSession, useMissionTaskSessionDemand } from "../stores/mission-task-sessions"
import { MissionPanelScope } from "./mission-panel-scope"
import { MissionTracking } from "./mission-tracking"
import { MissionTaskTree } from "./mission-task-tree"
import { missionTaskConversation } from "./mission-task-navigation"
import { missionQuestions } from "./mission-questions"
import type { MissionQuestion } from "./mission-question-owners"

/** An unselected, expanded one-time Mission's tasks: its full map is wanted only
 * while the row is expanded and `active` (shown), and its task pages load as the
 * panel scrolls. */
export function MissionTaskPreview(props: {
  instanceId: string; missionId: string; activity?: MissionActivityProjection; active: boolean
  selected: (mission: MissionPanelMap, task: MissionPanelTask) => boolean
  onSelect: (mission: MissionPanelMap, task: MissionPanelTask) => void
  onAnswer: (mission: MissionPanelMap, sessionId: string, request?: MissionQuestion["request"]) => void
}) {
  const owner = `preview:${createUniqueId()}`
  // Hidden (inactive panel, creation form), the preview keeps its expansion and wants nothing.
  createEffect(() => {
    const instanceId = props.instanceId, id = props.missionId
    if (!props.active) return
    untrack(() => missionStore.want(instanceId, owner, id))
    onCleanup(() => missionStore.want(instanceId, owner, undefined))
  })
  const map = () => missionStore.tasksLoaded(props.instanceId, props.missionId)
    ? missionStore.state(props.instanceId).missions.find(value => value.id === props.missionId) : undefined
  const observed = () => props.activity?.missions.find(value => value.missionId === props.missionId)
  // Like the selected Mission's tree: native task conversations and their activity,
  // paced by the activity projection's generation, while the panel is shown.
  useMissionTaskSessionDemand({ instanceId: () => props.instanceId, mission: map, active: () => props.active,
    pulse: () => props.activity?.generatedAt })
  const questions = createMemo(() => { const value = map(); return value ? missionQuestions({ instanceId: props.instanceId, mission: value,
    actors: value.actors, family: observed()?.family, store: missionStore }) : [] })
  return <Show when={map()}>
    {value => <MissionTaskTree mission={value()} instanceId={props.instanceId} activity={observed()?.actors} active={props.active}
      selected={task => props.selected(value(), task)} onSelect={task => props.onSelect(value(), task)}
      questions={questions()} onAnswer={(sessionId, request) => props.onAnswer(value(), sessionId, request)}
      conversation={task => missionTaskConversation(value(), task, observed()?.family, missionDerivedTaskSession(props.instanceId, value(), task.key),
        [...value().actors, ...missionStore.observedActors(props.instanceId, value().id)])} />}
  </Show>
}

/** An unselected, expanded schedule's live passage tasks: demands current passage
 * only while expanded and `active`, releasing cleanly on collapse. */
export function MissionPassagePreview(props: {
  instanceId: string; projectID?: string; directory: string
  scheduleId: string; owner: "daily" | "scheduled"; active: boolean; refresh: number
  selected: (mission: MissionPanelMap, task: MissionPanelTask) => boolean
  onSelect: (mission: MissionPanelMap, task: MissionPanelTask) => void
  onOpenActor: (mission: MissionPanelMap, sessionId: string, request?: MissionQuestion["request"]) => Promise<void>
}) {
  const passage = useMissionCurrentPassage({
    instanceId: () => props.instanceId,
    projectID: () => props.projectID,
    directory: () => props.directory,
    scheduleID: () => props.scheduleId,
    owner: () => props.owner,
    active: () => props.active,
    refresh: () => props.refresh,
  })
  const store = () => passage.inventory() ?? missionStore
  const map = () => passage.snapshot()?.scheduleID === props.scheduleId ? passage.snapshot()?.mission : undefined
  return <MissionPanelScope value={store}>
    <Show when={map()}>{value =>
      <MissionTracking instanceId={props.instanceId} mission={value()} activity={passage.snapshot()?.activity}
        active={props.active} selected={task => props.selected(value(), task)} onSelect={task => props.onSelect(value(), task)}
        onOpenActor={(sessionId, request) => props.onOpenActor(value(), sessionId, request)} />
    }</Show>
  </MissionPanelScope>
}
