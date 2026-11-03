import { For, Show, createUniqueId, onCleanup, type JSX } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { SettingsInfoTip } from "../settings/settings-info-tip"
import type { BundlesHostControl, BundlesHostNotice } from "./bundles-management"

/**
 * Trusted strip rendered by CodeNomad outside the opaque frame. Its button click
 * is the local-detach consent; nothing the frame posts can activate it.
 */
export function BundlesHostBanner(props: { controls: readonly BundlesHostControl[]; notice?: BundlesHostNotice
  detach(integration: string): void; restoreFocus(): void }) {
  const { t } = useI18n()
  // Application and document labels keep their own direction inside translated text.
  const labelled = (key: string, label: string): JSX.Element => {
    const [before = "", after = ""] = t(key, { label: "\u0000" }).split("\u0000")
    return <>{before}<bdi>{label}</bdi>{after}</>
  }
  // Rows are keyed by integration so a phase change keeps the focused button.
  const ids = () => props.controls.map(control => control.integration)
  return <div class="bundles-host-banner">
    <Show when={ids().length}>
      <div role="group" aria-label={t("integrations.host.region")}>
        <For each={ids()}>{id => {
          const control = () => props.controls.find(item => item.integration === id)
          const nameID = createUniqueId()
          let focused = false
          // Same contract as the confirmation's close: focus returns to a connected surface.
          onCleanup(() => { if (focused) queueMicrotask(props.restoreFocus) })
          return <Show when={control()}>{current => <div class="bundles-host-row" onFocusIn={() => { focused = true }} onFocusOut={() => { focused = false }}>
            <bdi id={nameID} class="bundles-host-name">{current().name}</bdi>
            <span class="bundles-host-state">{current().phase === "attached" ? labelled("integrations.binding.attached", current().label)
              : current().phase === "detaching" ? t("integrations.host.detaching") : t("integrations.binding.unknown")}</span>
            <SettingsInfoTip text={t("integrations.host.info")} />
            <button type="button" class="button-secondary bundles-host-detach" aria-describedby={nameID}
              aria-disabled={current().phase === "attached" ? undefined : "true"}
              onClick={() => { if (control()?.phase === "attached") props.detach(id) }}>{t("integrations.host.detach")}</button>
          </div>}</Show>
        }}</For>
      </div>
    </Show>
    <p class="sr-only" role="status" aria-live="polite">{props.notice ? labelled(props.notice.key, props.notice.label) : ""}</p>
  </div>
}
