import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, MessageCircleQuestion, ShieldCheck } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { getPermissionQueue, sendFormCancel, sendFormReply } from "../stores/instances"
import { getFormQueue } from "../stores/forms"
import { sessions } from "../stores/sessions"
import { interruptionFocus } from "../stores/interruption-navigation"
import FormRequest from "./form-request"
import { InterruptionPermission } from "./interruption-permission"

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
  const heading = () => t(current()?.kind === "permission" ? "interruption.permission" : "interruption.question")
  const sessionTitle = () => current()?.payload.sessionID === "global" ? t("interruption.global") : title(current()?.payload.sessionID ?? "")
  createEffect(on(() => props.sessionId, () => {
    setSelected(untrack(queue).find(item => item.payload.sessionID === props.sessionId)?.key ?? untrack(current)?.key)
    setCollapsed(false)
  }))
  createEffect(on(() => current()?.key, key => {
    // Pin the request being edited, even when a permission arrives ahead of it.
    setSelected(key)
    setCollapsed(false)
  }))
  createEffect(on(interruptionFocus, intent => {
    if (intent?.instanceId !== props.instanceId) return
    const item = untrack(queue).find(item => intent.requestId ? item.payload.id === intent.requestId
      : intent.sessionId ? item.payload.sessionID === intent.sessionId : item.key === untrack(current)?.key) ?? untrack(queue)[0]
    if (!item) return
    setSelected(item.key)
    setCollapsed(false)
    queueMicrotask(() => { if (props.active !== false && root?.isConnected) root.focus({ preventScroll: true }) })
  }))
  const move = (delta: number) => {
    const next = queue()[index() + delta]
    if (!next) return
    setSelected(next.key)
    setCollapsed(false)
  }

  return <Show when={queue().length > 0}>
    <section ref={root} class="interruption-dock window-shell" classList={{ "is-collapsed": collapsed() }} tabIndex={-1} aria-label={t("permissionApproval.title")}>
      <header class="window-header">
        <div class="interruption-heading">
          <Show when={current()?.kind === "permission"} fallback={<MessageCircleQuestion size={18} aria-hidden="true" />}><ShieldCheck size={18} aria-hidden="true" /></Show>
          <div class="interruption-heading-copy">
            <h2 class="window-title">{heading()}</h2>
            <span class="interruption-session" title={sessionTitle()}>{sessionTitle()}</span>
          </div>
        </div>
        <div class="window-actions">
          <Show when={queue().length > 1}>
            <div class="interruption-navigation">
              <button type="button" class="window-icon-button" disabled={index() === 0} aria-label={t("interruption.previous")} title={t("interruption.previous")} onClick={() => move(-1)}><ChevronLeft size={16} /></button>
              <span class="interruption-position" aria-live="polite">{index() + 1} / {queue().length}</span>
              <button type="button" class="window-icon-button" disabled={index() === queue().length - 1} aria-label={t("interruption.next")} title={t("interruption.next")} onClick={() => move(1)}><ChevronRight size={16} /></button>
            </div>
          </Show>
          <button type="button" class="window-icon-button interruption-toggle icon-toggle" aria-label={t(collapsed() ? "interruption.expand" : "interruption.collapse")} title={t(collapsed() ? "interruption.expand" : "interruption.collapse")} aria-expanded={!collapsed()}
            aria-controls={`interruption-body-${props.instanceId}`} onClick={() => setCollapsed(value => !value)}>
            <Show when={collapsed()} fallback={<ChevronDown size={16} />}><ChevronUp size={16} /></Show>
          </button>
        </div>
      </header>
      <div id={`interruption-body-${props.instanceId}`} class="window-body interruption-body" hidden={collapsed()}>
        {/* Stable request keys preserve partial answers across native reconciliation and queue navigation. */}
        <For each={queue().map(item => item.key)}>{key => {
          const item = () => byKey().get(key)!
          let editor: HTMLDivElement | undefined
          onCleanup(() => {
            if (!editor?.contains(document.activeElement)) return
            const composer = root?.closest(".session-view")?.querySelector<HTMLTextAreaElement>(".prompt-input")
            queueMicrotask(() => {
              if (props.active === false || (document.activeElement !== document.body && document.activeElement?.isConnected)) return
              if (root?.isConnected) root.focus({ preventScroll: true })
              else if (composer?.isConnected) composer.focus({ preventScroll: true })
            })
          })
          return <div ref={editor} class="interruption-editor" hidden={current()?.key !== key} inert={current()?.key !== key}>
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
