import { For, Show, createEffect, createMemo, on, onCleanup, untrack } from "solid-js"
import { ChevronLeft, ChevronRight, ChevronDown, MessageCircleQuestion, ShieldCheck, ShieldAlert } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { getPermissionQueue, sendFormCancel, sendFormReply } from "../stores/instances"
import { getFormQueue } from "../stores/forms"
import { sessions } from "../stores/sessions"
import { focusInterruption, interruptionFocus } from "../stores/interruption-navigation"
import FormRequest from "./form-request"
import { InterruptionPermission } from "./interruption-permission"
import { useInterruptionMinimumHeight } from "./interruption-dock-layout"
import { useInterruptionDockState } from "./interruption-dock-state"

export function InterruptionDock(props: { instanceId: string; sessionId?: string | null; active?: boolean; onExpandedChange?: (expanded: boolean) => void; onViewConversation?: (sessionId: string) => void }) {
  const { t } = useI18n()
  const { pending, current, expanded, select, index, move, previews, scope } = useInterruptionDockState(props)
  let root: HTMLElement | undefined
  const byKey = createMemo(() => new Map(pending().map(item => [item.key, item])))
  createEffect(() => props.onExpandedChange?.(expanded()))
  onCleanup(() => props.onExpandedChange?.(false))
  const minimumHeight = useInterruptionMinimumHeight(() => root, () => expanded() ? current()?.key : undefined)
  const title = (sessionId: string) => sessions().get(props.instanceId)?.get(sessionId)?.title || sessionId
  const sourceId = () => current()?.payload.sessionID ?? ""
  const own = () => sourceId() === props.sessionId
  const project = () => sourceId() === "global"
  const descendant = () => !own() && !project() && scope().has(sourceId())
  const externalQuestion = () => current()?.kind === "form" && !own() && !project() && !descendant()
  const origin = (sessionId: string) => sessionId === "global" ? t("interruption.projectRequest")
    : `${t(scope().has(sessionId) ? "interruption.subagent" : "interruption.otherConversation")} · ${title(sessionId)}`
  const heading = () => own() ? t(current()?.kind === "permission" ? "interruption.permission" : "interruption.question") : origin(sourceId())
  const parentTitle = () => title(sessions().get(props.instanceId)?.get(sourceId())?.parentId ?? props.sessionId ?? "")
  const canView = () => !own() && !project() && props.onViewConversation && sessions().get(props.instanceId)?.has(sourceId())
  const openLabel = (sessionId: string) => t("interruption.openExternal", { title: sessionId === "global" ? t("interruption.projectRequest") : title(sessionId) })
  createEffect(on(interruptionFocus, intent => {
    if (intent?.instanceId !== props.instanceId) return
    const item = untrack(pending).find(item => (!intent.kind || item.kind === intent.kind)
      && (!intent.sessionId || item.payload.sessionID === intent.sessionId)
      && (intent.requestId ? item.payload.id === intent.requestId
        : intent.sessionId ? true : item.key === untrack(current)?.key))
    if (!item) return
    select(item.key, true)
    const sessionId = props.sessionId
    queueMicrotask(() => {
      if (interruptionFocus() === intent && props.sessionId === sessionId && current()?.key === item.key
        && props.active !== false && root?.isConnected && !root.hidden) root.focus({ preventScroll: true })
    })
  }))

  return <Show when={pending().length > 0}>
    <section ref={root} class="interruption-dock window-shell" classList={{ "is-collapsed": !expanded(), "has-origin": !own() }}
      style={{ "min-height": expanded() && minimumHeight() !== undefined ? `${minimumHeight()}px` : undefined }} tabIndex={-1} aria-label={t("permissionApproval.title")}>
      <header class="window-header">
        <div class="interruption-heading">
          <button type="button" class="window-icon-button interruption-toggle icon-toggle" aria-label={!expanded() && !own() ? openLabel(sourceId()) : t(expanded() ? "interruption.collapse" : "interruption.expand")} title={t(expanded() ? "interruption.collapse" : "interruption.expand")} aria-expanded={expanded()}
            aria-controls={`interruption-body-${props.instanceId}`} onClick={() => select(current()!.key, !expanded())}>
            <Show when={expanded()} fallback={<ChevronRight size={16} aria-hidden="true" />}><ChevronDown size={16} aria-hidden="true" /></Show>
          </button>
          <Show when={externalQuestion()} fallback={
            <Show when={current()?.kind === "permission"} fallback={<MessageCircleQuestion size={18} aria-hidden="true" />}><ShieldCheck size={18} aria-hidden="true" /></Show>
          }>
            <span class="status-indicator session-status session-status-list session-permission badge-shape" role="img"
              aria-label={t("sessionList.status.needsInput")} title={t("sessionList.status.needsInput")}>
              <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" />
            </span>
          </Show>
          <div class="interruption-heading-copy">
            <h2 class="window-title" title={heading()}>
              <Show when={expanded() && !own() && !project()} fallback={heading()}>
                <span class="interruption-origin-kind">{t(descendant() ? "interruption.subagent" : "interruption.otherConversation")} · </span>
                <span class="interruption-origin-title">{title(sourceId())}</span>
              </Show>
            </h2>
            <Show when={own()}><span class="interruption-session" title={title(sourceId())}>{title(sourceId())}</span></Show>
          </div>
        </div>
        <Show when={pending().length > 1}>
          <div class="window-actions">
            <div class="interruption-navigation">
              <button type="button" class="window-icon-button" disabled={index() === 0} aria-label={t("interruption.previous")} title={t("interruption.previous")} onClick={() => move(-1)}><ChevronLeft size={16} /></button>
              <span class="interruption-position" aria-live="polite">{index() + 1} / {pending().length}</span>
              <button type="button" class="window-icon-button" disabled={index() === pending().length - 1} aria-label={t("interruption.next")} title={t("interruption.next")} onClick={() => move(1)}><ChevronRight size={16} /></button>
            </div>
          </div>
        </Show>
        <Show when={expanded() && (descendant() || canView())}>
          <div class="interruption-origin-actions">
            <Show when={descendant()}><span class="interruption-parent" title={parentTitle()}>{t("interruption.parentConversation", { title: parentTitle() })}</span></Show>
            <Show when={canView()}><button type="button" class="window-action" onClick={() => props.onViewConversation?.(sourceId())}>{t("interruption.viewConversation")}</button></Show>
          </div>
        </Show>
        <Show when={previews()[0]}>{preview =>
          <button type="button" class="interruption-external-preview" aria-label={openLabel(preview().payload.sessionID)}
            aria-expanded="false" aria-controls={`interruption-body-${props.instanceId}`}
            onClick={() => focusInterruption(props.instanceId, preview().payload.sessionID, preview().payload.id, preview().kind)}>
            <ChevronRight size={16} aria-hidden="true" />
            <span title={origin(preview().payload.sessionID)}>{origin(preview().payload.sessionID)}</span>
            <span class="interruption-position">{previews().length}</span>
          </button>
        }</Show>
      </header>
      <div id={`interruption-body-${props.instanceId}`} class="window-body interruption-body" hidden={!expanded()} inert={!expanded()}>
        {/* Stable request keys preserve partial answers across native reconciliation and queue navigation. */}
        <For each={pending().map(item => item.key)}>{key => {
          const item = () => byKey().get(key)!
          let editor: HTMLDivElement | undefined
          onCleanup(() => {
            if (!editor?.contains(document.activeElement)) return
            const composer = root?.closest(".session-view")?.querySelector<HTMLTextAreaElement>(".prompt-input")
            queueMicrotask(() => {
              if (props.active === false || (document.activeElement !== document.body && document.activeElement?.isConnected)) return
              if (root?.isConnected && !root.hidden) root.focus({ preventScroll: true })
              else if (composer?.isConnected) composer.focus({ preventScroll: true })
            })
          })
          return <div ref={editor} class="interruption-editor" hidden={!expanded() || current()?.key !== key} inert={!expanded() || current()?.key !== key}>
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
