import { Show, createEffect, createUniqueId, onCleanup, untrack } from "solid-js"
import type { MissionActivityProjection, MissionPanelMap, MissionPanelTask } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { missionStore } from "../stores/missions"
import { missionDerivedTaskSession } from "../stores/mission-task-sessions"
import { MissionTaskTree } from "./mission-task-tree"
import { missionTaskConversation } from "./mission-task-navigation"

/** An unselected, expanded one-time Mission's tasks: its full map is wanted only
 * while the row is expanded, and its task pages load as the panel scrolls. */
export function MissionTaskPreview(props: {
  instanceId: string; missionId: string; activity?: MissionActivityProjection; active: boolean
  reading: (mission: MissionPanelMap, task: MissionPanelTask) => boolean
  onRead: (mission: MissionPanelMap, task: MissionPanelTask) => void
}) {
  const { t } = useI18n()
  const owner = `preview:${createUniqueId()}`
  createEffect(() => {
    const instanceId = props.instanceId, id = props.missionId
    untrack(() => missionStore.want(instanceId, owner, id))
    onCleanup(() => missionStore.want(instanceId, owner, undefined))
  })
  const map = () => missionStore.state(props.instanceId).missions.find(value => value.id === props.missionId)
  const observed = () => props.activity?.missions.find(value => value.missionId === props.missionId)
  return <Show when={map()} fallback={<p class="mission-control-empty-line" role="status">{t("missions.control.loading")}</p>}>
    {value => <MissionTaskTree mission={value()} instanceId={props.instanceId} activity={observed()?.actors} active={props.active}
      reading={task => props.reading(value(), task)} onRead={task => props.onRead(value(), task)}
      conversation={task => missionTaskConversation(value(), task, observed()?.family, missionDerivedTaskSession(props.instanceId, value(), task.key),
        [...value().actors, ...missionStore.observedActors(props.instanceId, value().id)])} />}
  </Show>
}
