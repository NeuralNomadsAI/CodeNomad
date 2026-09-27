import { For, Show, createMemo, type Component } from "solid-js"
import { ArrowUpRight, MessageCircleQuestion } from "lucide-solid"

import type { MissionMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { getFormQueue } from "../stores/forms"
import { getPermissionQueue } from "../stores/instances"
import { MissionDisclosure } from "./mission-disclosure"
import { selectMissionAttention } from "./mission-attention-model"

/**
 * What the mission currently needs from the human: native Forms and permission
 * requests still held by one of its actors, including actors that are not the
 * active session, plus blockages already reported.
 *
 * Answering always happens in the actor conversation, so this section only routes
 * to it and never becomes a second reply path.
 */
export const MissionAttention: Component<{
  instanceId: string
  mission: MissionMap
  onOpenActor: (sessionId: string) => Promise<void>
}> = (props) => {
  const { t } = useI18n()
  const items = createMemo(() => selectMissionAttention({
    actors: props.mission.actors,
    forms: getFormQueue(props.instanceId),
    permissions: getPermissionQueue(props.instanceId),
    tasks: props.mission.tasks,
  }))
  const pending = createMemo(() => items().filter(item => item.open))
  const actorTitle = (sessionId: string) =>
    props.mission.actors.find(actor => actor.sessionId === sessionId)?.title ?? sessionId

  return (
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
          <For each={items()}>
            {(item) => (
              <li class="mission-attention-item" data-kind={item.kind} data-open={item.open ? "true" : "false"}>
                <span class="mission-attention-mark" aria-hidden="true" />
                <div class="mission-attention-copy">
                  <strong>{item.title}</strong>
                  <small>{t(`missions.control.attention.${item.kind}`)}</small>
                  <Show when={item.kind === "form" && item.questions}>
                    <span>{t("missions.control.attention.questions", { count: item.questions! })}</span>
                  </Show>
                  <Show when={item.resources?.length}>
                    <code>{item.resources!.join(" · ")}</code>
                  </Show>
                  <Show when={item.summary}>
                    <p class="mission-text-excerpt">{item.summary}</p>
                  </Show>
                </div>
                <Show
                  when={item.sessionId}
                  fallback={<small class="mission-attention-historic">{t("missions.control.attention.blockedHint")}</small>}
                >
                  {(sessionId) => (
                    <button
                      type="button"
                      class="mission-inline-session"
                      onClick={() => void props.onOpenActor(sessionId())}
                    >
                      <span>{t("missions.control.attention.openActor", { actor: actorTitle(sessionId()) })}</span>
                      <ArrowUpRight class="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </MissionDisclosure>
  )
}

export default MissionAttention
export * from "./mission-attention-model"
