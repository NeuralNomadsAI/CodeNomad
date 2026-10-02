import { For, Show, createEffect, createMemo, createSignal, on, untrack } from "solid-js"
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { getPermissionQueue, sendFormCancel, sendFormReply } from "../stores/instances"
import { getFormQueue } from "../stores/forms"
import { sessions, ensureSessionAncestorsExpanded, setActiveSessionFromList } from "../stores/sessions"
import { interruptionFocus, setInterruptionReveal } from "../stores/interruption-navigation"
import { getPermissionCallId, getPermissionMessageId } from "../types/permission"
import { explicitToolReference } from "./form-request-tool-target"
import FormRequest from "./form-request"
import { InterruptionPermission } from "./interruption-permission"
import { showSessionChat } from "../stores/session-previews"
import { closeFilePreview } from "../stores/files-preview"
import { instances } from "../stores/instances"

export function InterruptionDock(props: { instanceId: string; sessionId?: string | null; active?: boolean }) {
  const { t } = useI18n()
  const [selected, setSelected] = createSignal<string>()
  const [collapsed, setCollapsed] = createSignal(false)
  let root: HTMLElement | undefined
  const queue = createMemo(() => [
    ...getPermissionQueue(props.instanceId).map(payload => ({ key: `permission:${payload.id}`, kind: "permission" as const, payload })),
    ...getFormQueue(props.instanceId).map(payload => ({ key: `form:${payload.id}`, kind: "form" as const, payload })),
  ])
  const byKey = createMemo(() => new Map(queue().map(item => [item.key, item])))
  const current = createMemo(() => byKey().get(selected() ?? "") ?? queue().find(item => item.payload.sessionID === props.sessionId) ?? queue()[0])
  const index = () => queue().findIndex(item => item.key === current()?.key)
  const title = (sessionId: string) => sessions().get(props.instanceId)?.get(sessionId)?.title || sessionId
  const source = () => {
    const item = current()
    if (!item) return undefined
    const reference = item.kind === "form" ? explicitToolReference(item.payload) : {
      messageId: getPermissionMessageId(item.payload), callId: getPermissionCallId(item.payload),
    }
    return reference.messageId && item.payload.sessionID !== "global"
      ? { instanceId: props.instanceId, sessionId: item.payload.sessionID, messageId: reference.messageId, callId: reference.callId }
      : undefined
  }
  const reveal = () => {
    const target = source()
    if (!target) return
    closeFilePreview(props.instanceId)
    showSessionChat(instances().get(props.instanceId)?.folder ?? target.sessionId)
    ensureSessionAncestorsExpanded(props.instanceId, target.sessionId)
    setActiveSessionFromList(props.instanceId, target.sessionId)
    setInterruptionReveal(target)
  }
  createEffect(on(() => props.sessionId, () => {
    setSelected(undefined)
    setCollapsed(false)
  }))
  createEffect(on(() => current()?.key, () => setCollapsed(false)))
  createEffect(on(interruptionFocus, intent => {
    if (intent?.instanceId !== props.instanceId) return
    const item = untrack(queue).find(item => intent.requestId ? item.payload.id === intent.requestId
      : intent.sessionId ? item.payload.sessionID === intent.sessionId : true) ?? untrack(queue)[0]
    if (!item) return
    setSelected(item.key)
    setCollapsed(false)
    queueMicrotask(() => { if (props.active !== false && root?.isConnected) root.focus({ preventScroll: true }) })
  }))
  const move = (delta: number) => setSelected(queue()[(index() + delta + queue().length) % queue().length]?.key)

  return <Show when={queue().length > 0}>
    <section ref={root} class="interruption-dock window-shell" tabIndex={-1} aria-label={t("permissionApproval.title")}>
      <header class="window-header">
        <h2 class="window-title">{t("permissionApproval.title")}</h2>
        <span class="badge-shape">{index() + 1} / {queue().length}</span>
        <div class="window-actions">
          <button type="button" class="window-action" disabled={queue().length < 2} aria-label={t("interruption.previous")} onClick={() => move(-1)}><ChevronLeft size={16} /></button>
          <button type="button" class="window-action" disabled={queue().length < 2} aria-label={t("interruption.next")} onClick={() => move(1)}><ChevronRight size={16} /></button>
          <button type="button" class="window-action icon-toggle" aria-label={t("interruption.toggle")} aria-expanded={!collapsed()}
            aria-controls={`interruption-body-${props.instanceId}`} onClick={() => setCollapsed(value => !value)}><ChevronDown size={16} /></button>
        </div>
      </header>
      <div class="window-toolbar interruption-toolbar">
        <span>{current()?.payload.sessionID === "global" ? t("interruption.global") : title(current()?.payload.sessionID ?? "")}</span>
        <Show when={source()}><button type="button" class="window-action" onClick={reveal}>{t("interruption.reveal")}</button></Show>
      </div>
      <div id={`interruption-body-${props.instanceId}`} class="window-body interruption-body" hidden={collapsed()}>
        {/* Stable request keys preserve partial answers across native reconciliation and queue navigation. */}
        <For each={queue().map(item => item.key)}>{key => {
          const item = () => byKey().get(key)!
          return <div hidden={current()?.key !== key} inert={current()?.key !== key}>
            <Show when={item().kind === "form"} fallback={<InterruptionPermission instanceId={props.instanceId} permission={item().payload as ReturnType<typeof getPermissionQueue>[number]} />}>
              <FormRequest form={item().payload as ReturnType<typeof getFormQueue>[number]}
                onReply={answer => sendFormReply(props.instanceId, item().payload.id, answer)} onCancel={() => sendFormCancel(props.instanceId, item().payload.id)} />
            </Show>
          </div>
        }}</For>
      </div>
    </section>
  </Show>
}
