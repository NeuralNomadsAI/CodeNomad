import { For, Show, createMemo, type Component } from "solid-js"
import { MessageCircleQuestion } from "lucide-solid"

import type { MissionPanelMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { getFormQueue } from "../stores/forms"
import { getPermissionQueue } from "../stores/instances"
import { sessions } from "../stores/session-state"
import { selectMissionAttention, type MissionObservedFamily } from "./mission-attention-model"
import { missionStore } from "../stores/missions"
import type { MissionAttentionItem } from "./mission-attention-model"

/**
 * "Needs you": native Forms and permission requests still held by one of the
 * mission's actors, including actors that are not the active session. It renders
 * only while such a request is open.
 *
 * Answering always happens in the shell's interruption dock of the actor
 * conversation, so this block only routes there and never becomes a reply path.
 */
export const MissionAttention: Component<{
  instanceId: string
  mission: MissionPanelMap
  family?: MissionObservedFamily
  onOpenActor: (sessionId: string, request?: { kind: "form" | "permission"; id: string }) => Promise<void>
}> = (props) => {
  const { t } = useI18n()
  const items = createMemo(() => {
    const native = selectMissionAttention({
    actors: [...props.mission.actors, ...missionStore.observedActors(props.instanceId, props.mission.id)],
    forms: getFormQueue(props.instanceId),
    permissions: getPermissionQueue(props.instanceId),
    tasks: props.mission.tasks,
    family: props.family,
    }).filter(item => item.open && item.sessionId && item.kind !== "blocked")
    const observed: MissionAttentionItem[] = props.mission.panelCollections ? missionStore.observations(props.instanceId, props.mission.id).flatMap(page => page.requests.items.map(item => ({
      id: `${item.kind}:${item.request.id}`, kind: item.kind, sessionId: item.request.sessionID, actorSessionId: item.actorSessionId, open: page.requests.state !== "unknown",
      title: String(item.request.title ?? item.request.action ?? item.request.id),
      ...(item.kind === "form" && Array.isArray(item.request.fields) ? { questions: item.request.fields.length } : {}),
      ...(item.kind === "permission" && Array.isArray(item.request.resources) ? { resources: item.request.resources.filter((value): value is string => typeof value === "string") } : {}),
    }))) : []
    return [...new Map([...observed, ...native].map(item => [JSON.stringify([item.kind, item.id, item.sessionId]), item])).values()]
  })
  // Native request IDs are scoped by kind/session and the containing mission.
  // Keep rows across display refetches, never across a different answer target.
  const rows = createMemo(() => new Map(items().map(item => [JSON.stringify([
    props.instanceId, props.mission.id, item.kind, item.id,
    item.sessionId ?? null, item.actorSessionId ?? null, item.taskKey ?? null,
  ]), item])))
  // Declared title, else the native conversation title; identifiers stay out of the card.
  const actorTitle = (sessionId: string) => props.mission.actors.find(actor => actor.sessionId === sessionId)?.title
    || missionStore.observations(props.instanceId, props.mission.id).flatMap(page => page.context.actors).find(actor => actor.sessionId === sessionId)?.title
    || sessions().get(props.instanceId)?.get(sessionId)?.title
    || t(sessionId === props.mission.coordinatorSessionId ? "missions.control.actor.coordinator" : "missions.control.actor.specialist")

  return (
    <Show when={items().length > 0}>
      <section class="mission-needs" aria-label={t("missionsPanel.needsYou")}>
        <ul class="mission-attention-list">
          <For each={[...rows().keys()]}>
            {key => <Show when={rows().get(key)}>{item => {
              // One line: who asks stays in the tooltip/description, the question opens in the dock.
              const detail = () => [t(`missionsPanel.needs.${item().kind}`, { actor: actorTitle(item().actorSessionId ?? item().sessionId!) }),
                ...(item().kind === "form" && item().questions ? [t("missions.control.attention.questions", { count: item().questions! })] : []),
                ...(item().resources?.length ? [item().resources!.join(" · ")] : [])].join(" · ")
              return <li class="mission-needs-item" data-kind={item().kind}>
                <MessageCircleQuestion class="h-3.5 w-3.5 mission-needs-icon" aria-hidden="true" />
                <span class="mission-needs-title" title={`${item().title} · ${detail()}`}>{item().title}</span>
                <span class="sr-only">{detail()}</span>
                <button type="button" class="window-action mission-needs-answer"
                  disabled={!item().open}
                  aria-description={t("missions.control.attention.openActor", { actor: actorTitle(item().sessionId!) })}
                  onClick={() => {
                    const current = rows().get(key)
                    if (current?.open && current.sessionId && current.kind !== "blocked") void props.onOpenActor(current.sessionId,
                      { kind: current.kind, id: current.id.slice(current.kind.length + 1) })
                  }}>{t("missionsPanel.answer")}</button>
              </li>
            }}</Show>}
          </For>
        </ul>
      </section>
    </Show>
  )
}

export default MissionAttention
export * from "./mission-attention-model"
