import { For, Show, createMemo, type Component } from "solid-js"
import { Activity, ArrowUpRight } from "lucide-solid"

import type { MissionActorActivity, MissionMap } from "../../../server/src/api-types"
import { MissionDisclosure } from "./mission-disclosure"
import { hasUnreturnedNativeInvocation, missionActivityKey, missionNativeCallKey } from "./mission-native-execution-model"
import { selectMissionFamilyMembers, type MissionObservedFamily } from "./mission-attention-model"

interface MissionActorsProps {
  mission: MissionMap
  activity?: MissionActorActivity[]
  family?: MissionObservedFamily
  sessionTitle?: (sessionId: string) => string
  activeSessionId: string | null
  onOpenActor: (sessionId: string) => Promise<void>
  t: (key: string, vars?: Record<string, any>) => string
}

export const MissionActors: Component<MissionActorsProps> = (props) => {
  const observed = createMemo(() => new Map(props.activity?.map(item => [item.sessionId, item.state]) ?? []))
  const descendants = createMemo(() => selectMissionFamilyMembers(props.mission.actors, props.family))
  const title = (id: string) => props.sessionTitle?.(id) ?? id
  const assignment = (sessionId: string) => [...props.mission.tasks].reverse().find(task => task.actorSessionId === sessionId
    && (hasUnreturnedNativeInvocation(task) || (!task.report && (task.status === "dispatching" || task.status === "queued" || task.outstandingExecution))))

  return <MissionDisclosure missionId={props.mission.id} name="actors" defaultOpen={false}
    title={<><Activity class="h-4 w-4" aria-hidden="true" /><span>{props.t("missions.control.activity.title")}</span><small>{props.mission.actors.length}</small></>}>
    <p class="mission-activity-intro">{props.t("missions.control.activity.detail")}</p>
    <small class="mission-activity-intro">{props.t("missions.control.family.declared")}</small>
    <div class="mission-activity-list">
      <For each={props.mission.actors}>{actor => {
        const state = () => observed().get(actor.sessionId) ?? "unknown"
        const current = () => assignment(actor.sessionId)
        return <div class="mission-activity-actor" classList={{ "mission-activity-actor-active": props.activeSessionId === actor.sessionId }}>
          <span class="mission-activity-signal" data-state={state()} aria-hidden="true" />
          <div class="mission-activity-copy">
            <strong>{actor.title}</strong>
            <span>{props.t(actor.kind === "coordinator" ? "missions.control.actor.coordinator" : "missions.control.actor.specialist")} · {actor.roles.join(", ")}</span>
             <Show when={current()}>{task => <span class="mission-activity-assignment">{props.t("missions.control.activity.assignment", { task: task().title })}</span>}</Show>
             <Show when={current()?.nativeExecution}><span>{props.t(missionNativeCallKey(current()!))}</span></Show>
          </div>
          <div class="mission-activity-actions">
            <small data-state={state()}>{props.t(missionActivityKey(state(), Boolean(current()?.nativeBinding) || current()?.executionMode?.kind === "native"))}</small>
            <button type="button" class="mission-control-icon-button"
              aria-label={props.t("missions.control.actor.open", { actor: actor.title })}
              title={props.t("missions.control.actor.open", { actor: actor.title })}
              onClick={() => void props.onOpenActor(actor.sessionId)}>
              <ArrowUpRight class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      }}</For>
    </div>
    <Show when={props.family?.state !== "observed"}><p class="mission-activity-intro">{props.t("missions.control.family.unknown")}</p></Show>
    <Show when={descendants().length}>
      <small class="mission-activity-intro">{props.t("missions.control.family.ordinary")}</small>
      <div class="mission-activity-list">
        <For each={descendants()}>{member => <div class="mission-activity-actor" data-family-kind="ordinary" data-session-id={member.sessionId}
          data-native-parent-id={member.parentSessionId} data-declared-actor-id={member.actorSessionId}
          classList={{ "mission-activity-actor-active": props.activeSessionId === member.sessionId }}>
          <span aria-hidden="true" />
          <div class="mission-activity-copy">
            <strong title={title(member.sessionId)}>{title(member.sessionId)}</strong>
            <span>{props.t("missions.control.family.ancestry", { parent: title(member.parentSessionId!),
              actor: props.mission.actors.find(actor => actor.sessionId === member.actorSessionId)?.title ?? member.actorSessionId })}</span>
          </div>
          <div class="mission-activity-actions"><button type="button" class="mission-control-icon-button"
            aria-label={props.t("missions.control.actor.open", { actor: title(member.sessionId) })}
            title={props.t("missions.control.actor.open", { actor: title(member.sessionId) })}
            onClick={() => void props.onOpenActor(member.sessionId)}><ArrowUpRight class="h-3.5 w-3.5" aria-hidden="true" /></button></div>
        </div>}</For>
      </div>
    </Show>
  </MissionDisclosure>
}
