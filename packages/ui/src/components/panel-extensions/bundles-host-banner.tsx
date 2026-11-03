import { For, Show, onCleanup } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { SettingsInfoTip } from "../settings/settings-info-tip"
import type { BundlesHostControl, BundlesHostNotice } from "./bundles-management"

/**
 * Trusted strip rendered by CodeNomad outside the opaque frame. Its button click
 * is the D24 local-detach consent; nothing the frame posts can activate it.
 */
export function BundlesHostBanner(props: { controls: readonly BundlesHostControl[]; notice?: BundlesHostNotice
  detach(integration: string): void; restoreFocus(): void }) {
  const { t } = useI18n()
  // Rows are keyed by integration so a phase change keeps the focused button.
  const ids = () => props.controls.map(control => control.integration)
  return <div class="bundles-host-banner">
    <Show when={ids().length}>
      <div role="group" aria-label={t("integrations.host.region")}>
        <For each={ids()}>{id => {
          const control = () => props.controls.find(item => item.integration === id)
          let focused = false
          // Same contract as the confirmation's close: focus returns to a connected surface.
          onCleanup(() => { if (focused) queueMicrotask(props.restoreFocus) })
          return <Show when={control()}>{current => <div class="bundles-host-row" onFocusIn={() => { focused = true }} onFocusOut={() => { focused = false }}>
            <bdi class="bundles-host-name">{current().name}</bdi>
            <span class="bundles-host-state">{current().phase === "attached" ? t("integrations.binding.attached", { label: current().label })
              : current().phase === "detaching" ? t("integrations.host.detaching") : t("integrations.binding.unknown")}</span>
            <SettingsInfoTip text={t("integrations.host.info")} />
            <button type="button" class="button-secondary bundles-host-detach" aria-disabled={current().phase === "attached" ? undefined : "true"}
              onClick={() => { if (control()?.phase === "attached") props.detach(id) }}>{t("integrations.host.detach")}</button>
          </div>}</Show>
        }}</For>
      </div>
    </Show>
    <p class="sr-only" role="status" aria-live="polite">{props.notice ? t(props.notice.key, { label: props.notice.label }) : ""}</p>
  </div>
}
