import { For, Show, createMemo, type Component } from "solid-js"
import { MessagesSquare, ArrowUpRight } from "lucide-solid"

import type { MissionActorActivity, MissionMap } from "../../../server/src/api-types"
import { sessions } from "../stores/session-state"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionListItem } from "./mission-list-item"
import { hasUnreturnedNativeInvocation, missionActivityKey } from "./mission-native-execution-model"
import type { MissionObservedFamily } from "./mission-attention-model"
import { missionConversationTree, missionConversationRuntimeState, type MissionConversationNode } from "./mission-conversation-tree"

interface MissionActorsProps {
  mission: MissionMap
  activity?: MissionActorActivity[]
  family?: MissionObservedFamily
  instanceId?: string
  sessionTitle?: (sessionId: string) => string
  activeSessionId: string | null
  onOpenActor: (sessionId: string) => Promise<void>
  t: (key: string, vars?: Record<string, any>) => string
}

export const MissionActors: Component<MissionActorsProps> = (props) => {
  const observed = createMemo(() => new Map(props.activity?.map(item => [item.sessionId, item.state]) ?? []))
  const tree = createMemo(() => missionConversationTree(props.mission.actors, props.family))
  const nodes = createMemo(() => {
    const index = new Map<string, MissionConversationNode>()
    const visit = (node: MissionConversationNode) => { index.set(node.sessionId, node); node.children.forEach(visit) }
    tree().roots.forEach(visit)
    return index
  })
  const title = (node: MissionConversationNode) => node.actor?.title ?? props.sessionTitle?.(node.sessionId) ?? node.sessionId
  const Row: Component<{ id: string }> = (row) => {
    const node = () => nodes().get(row.id)!
    const familyScoped = () => Boolean(node().actor && !node().parentSessionId)
    const exactState = () => missionConversationRuntimeState(props.instanceId ? sessions().get(props.instanceId)?.get(node().sessionId) : undefined)
    const state = () => familyScoped() ? observed().get(node().sessionId) ?? "unknown" : exactState()
    const statusKey = () => familyScoped() ? missionActivityKey(state() as MissionActorActivity["state"], false)
      : state() === "idle" || state() === "compacting" ? `missions.control.conversations.state.${state()}`
        : missionActivityKey(exactState() as MissionActorActivity["state"], false)
    const assignment = () => {
      const assigned = props.mission.tasks.filter(task => task.actorSessionId === node().sessionId
        && (hasUnreturnedNativeInvocation(task) || (!task.report && (task.status === "dispatching" || task.status === "queued" || task.outstandingExecution))))
      return assigned.length === 1 ? assigned[0] : undefined
    }
    const context = () => assignment() ? props.t("missions.control.activity.assignment", { task: assignment()!.title }) : node().actor
      ? `${props.t(node().actor!.kind === "coordinator" ? "missions.control.actor.coordinator" : "missions.control.actor.specialist")} · ${props.t("missions.control.family.declared")} · ${node().actor!.roles.join(", ")}`
      : props.t("missions.control.family.ordinary")
    return <li class="mission-conversation-node" data-session-id={node().sessionId}
      data-family-kind={node().actor ? "declared" : "ordinary"} data-native-parent-id={node().parentSessionId}
      data-declared-actor-id={node().actorSessionId}>
      <div class="mission-activity-actor">
        <MissionListItem selected={props.activeSessionId === node().sessionId} title={title(node())}
          text={<div class="mission-activity-copy"><strong>{title(node())}</strong><span title={context()}>{context()}</span></div>}
          statusKind={state()} status={<span data-state={state()}>{familyScoped()
            ? props.t("missions.control.conversations.familyState", { state: props.t(statusKey()) }) : props.t(statusKey())}</span>}
          actions={[{ key: "open", label: props.t("missions.control.actor.open", { actor: title(node()) }),
            icon: <ArrowUpRight class="h-3.5 w-3.5" aria-hidden="true" />, onSelect: () => props.onOpenActor(node().sessionId) }]} />
      </div>
      <Show when={node().children.length}><ul class="mission-conversation-children">
        <For each={node().children.map(child => child.sessionId)}>{id => <Row id={id} />}</For>
      </ul></Show>
    </li>
  }
  return <MissionDisclosure missionId={props.mission.id} name="actors" defaultOpen={false}
    title={<><MessagesSquare class="h-4 w-4" aria-hidden="true" /><span>{props.t("missions.control.conversations.title")}</span><small>{tree().count}</small></>}>
    <p class="mission-activity-intro">{props.t("missions.control.conversations.detail")}</p>
    <ul class="mission-activity-list"><For each={tree().roots.map(node => node.sessionId)}>{id => <Row id={id} />}</For></ul>
    <Show when={!tree().known}><p class="mission-activity-intro">{props.t("missions.control.family.unknown")}</p></Show>
  </MissionDisclosure>
}
