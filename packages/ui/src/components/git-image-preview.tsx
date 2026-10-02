import { For, Show, createEffect, createSignal, on } from "solid-js"
import type { GitImageDiff } from "../../../server/src/git-history-types"
import { useI18n } from "../lib/i18n"

export function GitImagePreview(props: { image: GitImageDiff; path: string; view: "split" | "unified" }) {
  const { t } = useI18n()
  return <div class="git-image-diff" data-view={props.view}>
    <For each={["before", "after"] as const}>{side => {
      const [failed, setFailed] = createSignal(false)
      createEffect(on(() => props.image[side], () => setFailed(false)))
      return <Show when={props.image[side]}>{bytes => <figure class="git-image-version">
        <figcaption>{t(`filesPanel.image.${side}`)}</figcaption>
        <Show when={!failed()} fallback={<p class="p-3 text-secondary">{t("filesPanel.binary")}</p>}>
          <img src={`data:${props.image.mime};base64,${bytes()}`} alt={`${props.path} · ${t(`filesPanel.image.${side}`)}`} onError={() => setFailed(true)} />
        </Show>
      </figure>}</Show>
    }}</For>
  </div>
}
