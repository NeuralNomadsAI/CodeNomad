import { Show, createEffect, createUniqueId, onCleanup, untrack } from "solid-js"
import type { MissionActivityProjection, MissionPanelMap, MissionPanelTask } from "../../../server/src/api-types"
import { missionStore } from "../stores/missions"
import { useMissionCurrentPassage } from "../stores/mission-recurrence"
import { MissionPanelScope } from "./mission-panel-scope"
import { MissionTracking } from "./mission-tracking"
import type { MissionQuestionStore } from "./mission-questions"
import type { MissionQuestion } from "./mission-question-owners"

/** An unselected, expanded one-time Mission's tasks: its full map is wanted only
 * while the row is expanded and `active` (shown), and its task pages load as the
 * panel scrolls. */
export function MissionTaskPreview(props: {
  instanceId: string; missionId: string; activity?: MissionActivityProjection; active: boolean
  selected: (mission: MissionPanelMap, task: MissionPanelTask) => boolean
  onSelect: (mission: MissionPanelMap, task: MissionPanelTask) => void
  onAnswer: (mission: MissionPanelMap, sessionId: string, request?: MissionQuestion["request"]) => Promise<void>
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
  return <Show when={map()}>
    {value => <MissionTracking instanceId={props.instanceId} mission={value()} activity={props.activity} active={props.active}
      selected={task => props.selected(value(), task)} onSelect={task => props.onSelect(value(), task)}
      onOpenActor={(sessionId, request) => props.onAnswer(value(), sessionId, request)} />}
  </Show>
}

export interface MissionPassageIdentity {
  projectID: string
  scheduleID: string
  passageID: string
  owner?: "daily" | "scheduled"
}

export interface MissionPassageActorClick {
  scheduleID: string
  passageID: string
  missionId: string
  sessionId: string
  request?: MissionQuestion["request"]
  live: () => {
    mission: MissionPanelMap
    store: MissionQuestionStore
    family?: MissionActivityProjection["missions"][number]["family"]
  } | undefined
}

/** An unselected, expanded schedule's live passage tasks: demands current passage
 * only while expanded and `active`, releasing cleanly on collapse. */
export function MissionPassagePreview(props: {
  instanceId: string; projectID?: string; directory: string
  scheduleId: string; owner: "daily" | "scheduled"; active: boolean; refresh: number
  onRegisterRefresh?: (refresh: () => Promise<void>) => () => void
  selected: (mission: MissionPanelMap, task: MissionPanelTask) => boolean
  onSelect: (mission: MissionPanelMap, task: MissionPanelTask, passage: MissionPassageIdentity) => void
  onOpenActor: (click: MissionPassageActorClick) => Promise<void>
}) {
  let alive = true
  onCleanup(() => { alive = false })
  const passage = useMissionCurrentPassage({
    instanceId: () => props.instanceId,
    projectID: () => props.projectID,
    directory: () => props.directory,
    scheduleID: () => props.scheduleId,
    owner: () => props.owner,
    active: () => props.active,
    refresh: () => props.refresh,
  })
  const unregister = props.onRegisterRefresh?.(() => passage.refreshNow())
  onCleanup(() => unregister?.())
  const store = () => passage.inventory() ?? missionStore
  const current = () => {
    const snapshot = passage.snapshot()
    return snapshot?.scheduleID === props.scheduleId && snapshot.passageID && snapshot.mission ? snapshot : undefined
  }
  const map = () => current()?.mission
  return <MissionPanelScope value={store}>
    <Show when={map()}>{value =>
      <MissionTracking instanceId={props.instanceId} mission={value()} activity={current()?.activity}
        active={props.active} selected={task => props.selected(value(), task)}
        onSelect={task => {
          const snapshot = current()
          if (!snapshot?.passageID) return
          const owner = snapshot.source?.owner ?? props.owner
          props.onSelect(value(), task, {
            projectID: snapshot.projectID,
            scheduleID: snapshot.scheduleID,
            passageID: snapshot.passageID,
            ...(owner === "scheduled" ? { owner: "scheduled" as const } : {}),
          })
        }}
        onOpenActor={(sessionId, request) => {
          const clicked = current()
          const clickedPassageID = clicked?.passageID, clickedMissionID = clicked?.mission?.id
          if (!clickedPassageID || !clickedMissionID) return Promise.resolve()
          return props.onOpenActor({
            scheduleID: props.scheduleId,
            passageID: clickedPassageID,
            missionId: clickedMissionID,
            sessionId,
            request,
            live: () => {
              if (!alive) return undefined
              const now = current()
              if (!now || now.passageID !== clickedPassageID || !now.mission || now.mission.id !== clickedMissionID) return undefined
              return {
                mission: now.mission,
                store: store(),
                family: now.activity?.missions.find(item => item.missionId === now.mission!.id)?.family,
              }
            },
          })
        }} />
    }</Show>
  </MissionPanelScope>
}
