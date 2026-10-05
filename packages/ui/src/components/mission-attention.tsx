import { For, Show, createMemo, type Component } from "solid-js"
import { ArrowUpRight, MessageCircleQuestion } from "lucide-solid"

import type { MissionMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { getFormQueue } from "../stores/forms"
import { getPermissionQueue } from "../stores/instances"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionListItem } from "./mission-list-item"
import { selectMissionAttention, type MissionObservedFamily } from "./mission-attention-model"

/**
 * What the mission currently needs from the human: native Forms and permission
 * requests still held by one of its actors, including actors that are not the
 * active session. Returned blockages have their own section.
 *
 * Answering always happens in the actor conversation, so this section only routes
 * to it and never becomes a second reply path.
 */
export const MissionAttention: Component<{
  instanceId: string
  mission: MissionMap
  family?: MissionObservedFamily
  onOpenActor: (sessionId: string, request?: { kind: "form" | "permission"; id: string }) => Promise<void>
}> = (props) => {
  const { t } = useI18n()
  const items = createMemo(() => selectMissionAttention({
    actors: props.mission.actors,
    forms: getFormQueue(props.instanceId),
    permissions: getPermissionQueue(props.instanceId),
    tasks: props.mission.tasks,
    family: props.family,
  }))
  const pending = createMemo(() => items().filter(item => item.open))
  // Native request IDs are scoped by kind/session and the containing mission.
  // Keep rows across display refetches, never across a different answer target.
  const rows = createMemo(() => new Map(items().map(item => [JSON.stringify([
    props.instanceId, props.mission.id, item.kind, item.id,
    item.sessionId ?? null, item.actorSessionId ?? null, item.taskKey ?? null,
  ]), item])))
  const actorTitle = (sessionId: string) =>
    props.mission.actors.find(actor => actor.sessionId === sessionId)?.title ?? sessionId

  return (
    <Show when={items().length > 0}>
    <MissionDisclosure
      missionId={props.mission.id}
      name="attention"
      defaultOpen={pending().length > 0}
      title={
        <>
          <MessageCircleQuestion class="h-4 w-4" aria-hidden="true" />
          <span>{t("missions.control.attention.title")}</span>
          <Show when={pending().length}>
            <span class="badge-shape neutral-badge mission-attention-count">{pending().length}</span>
          </Show>
        </>
      }
    >
      <Show
        when={items().length}
        fallback={<p class="mission-control-empty-line">{t("missions.control.attention.empty")}</p>}
      >
        <ul class="mission-attention-list">
          <For each={[...rows().keys()]}>
            {key => <Show when={rows().get(key)}>{item =>
              <li class="min-w-0"><MissionListItem statusKind={item().open ? item().kind : undefined}
                text={<><strong>{item().title}</strong>{" "}
                   <Show when={item().actorSessionId && item().actorSessionId !== item().sessionId}>
                      <span>{t("missions.control.family.ancestry", { parent: props.family?.members.find(member => member.sessionId === item().sessionId)?.parentSessionId ?? "", actor: actorTitle(item().actorSessionId!) })}{" "}</span>
                   </Show>
                  <Show when={item().kind === "form" && item().questions}>
                    <span>{t("missions.control.attention.questions", { count: item().questions! })}</span>
                  </Show>
                  <Show when={item().resources?.length}>
                    <code>{item().resources!.join(" · ")}</code>
                  </Show>
                  <Show when={item().summary}>
                    <span>{" "}{item().summary}</span>
                  </Show>
                </>}
                status={<>{t(`missions.control.attention.${item().kind}`)}<Show when={!item().sessionId}>{" · "}{t("missions.control.attention.blockedHint")}</Show></>}
                actions={item().sessionId ? [{ key: "actor", label: t("missions.control.attention.openActor", { actor: actorTitle(item().sessionId!) }),
                  icon: <ArrowUpRight class="h-3.5 w-3.5" />, onSelect: () => {
                    const current = rows().get(key)
                     if (current?.open && current.sessionId && current.kind !== "blocked") return props.onOpenActor(current.sessionId,
                       { kind: current.kind, id: current.id.slice(current.kind.length + 1) })
                  } }] : []} /></li>
            }</Show>}
          </For>
        </ul>
      </Show>
    </MissionDisclosure>
    </Show>
  )
}

export default MissionAttention
export * from "./mission-attention-model"
