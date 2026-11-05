import { createSignal, onCleanup, Show, type JSX } from "solid-js"
import { useI18n } from "../../lib/i18n"

/** Host settings require a deliberate local action when Preferences targets another service.
 * A grant belongs to this exact accepted target; retained handlers lose it on transition. */
export function LocalBackendSettings(props: { target: string; local: boolean; children: (active: () => boolean) => JSX.Element }) {
  const { t } = useI18n()
  return <Show when={props.target} keyed>{target => {
    const [granted, setGranted] = createSignal(false)
    let alive = true
    let content: HTMLDivElement | undefined
    onCleanup(() => { alive = false })
    const active = () => alive && props.target === target && (props.local || granted())
    return <div class="settings-section-stack">
      <p class="settings-card-message" role="note">{t("settings.execution.localBackend")}</p>
      <Show when={!props.local}><p class="settings-card-message">{t("settings.execution.localOnly")}</p></Show>
      <Show when={props.local || granted()} fallback={<button type="button" class="window-action" onClick={() => {
        if (!alive || props.target !== target) return
        setGranted(true)
        queueMicrotask(() => { if (active() && document.hasFocus() && content?.isConnected) content.focus() })
      }}>{t("settings.execution.manageLocal")}</button>}>
        <div ref={content} role="group" aria-label={t("settings.execution.localBackend")} tabIndex={-1}>
          {props.children(active)}
        </div>
      </Show>
    </div>
  }}</Show>
}
