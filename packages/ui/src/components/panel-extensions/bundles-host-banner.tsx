import { For, Show, createEffect, createUniqueId, on, onCleanup, type JSX } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { BUNDLES_CONFIRM_GUARD_MS } from "../../../../server/src/panel-extensions/bundles-lifecycle"
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
  // The frame decides when reads land, so any row insertion or re-enable can move a button
  // under the pointer: activation counts only once the banner layout has been stable.
  let stableAt = Date.now()
  createEffect(on(() => props.controls.map(control => `${control.integration}:${control.phase}`).join(), () => { stableAt = Date.now() }))
  const settled = () => Date.now() - stableAt >= BUNDLES_CONFIRM_GUARD_MS
  let root: HTMLDivElement | undefined
  // Same contract as the confirmation's close: focus moves to a remaining row, else to the frame.
  const refocus = () => {
    const next = root?.querySelector<HTMLButtonElement>(".bundles-host-detach")
    if (next) next.focus(); else props.restoreFocus()
  }
  return <div ref={root} class="bundles-host-banner">
    <Show when={ids().length}>
      <div role="group" aria-label={t("integrations.host.region")}>
        <For each={ids()}>{id => {
          const control = () => props.controls.find(item => item.integration === id)
          const nameID = createUniqueId(), buttonID = createUniqueId()
          let focused = false
          onCleanup(() => { if (focused) queueMicrotask(refocus) })
          const state = () => {
            const current = control()
            return !current ? "" : current.phase === "attached" ? t("integrations.binding.attached", { label: current.label })
              : current.phase === "detaching" ? t("integrations.host.detaching") : t("integrations.binding.unknown")
          }
          return <Show when={control()}>{current => <div class="bundles-host-row" onFocusIn={() => { focused = true }} onFocusOut={() => { focused = false }}>
            <bdi id={nameID} class="bundles-host-name" title={current().name}>{current().name}</bdi>
            <span class="bundles-host-state" title={state()}>{current().phase === "attached" ? labelled("integrations.binding.attached", current().label) : state()}</span>
            <SettingsInfoTip text={t("integrations.host.info")} />
            <button id={buttonID} type="button" class="button-secondary bundles-host-detach" aria-labelledby={`${buttonID} ${nameID}`}
              aria-disabled={current().phase === "attached" ? undefined : "true"}
              onClick={() => { if (control()?.phase === "attached" && settled()) props.detach(id) }}>{t("integrations.host.detach")}</button>
          </div>}</Show>
        }}</For>
      </div>
    </Show>
    <p class="sr-only" role="status" aria-live="polite">{props.notice ? labelled(props.notice.key, props.notice.label) : ""}</p>
  </div>
}
