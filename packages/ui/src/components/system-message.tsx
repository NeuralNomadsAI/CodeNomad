import { Show, createEffect, createSignal } from "solid-js"
import { ChevronRight, Info } from "lucide-solid"
import type { ClientPart } from "../types/message"
import type { VisibilityPreference } from "../stores/preferences"
import { useI18n } from "../lib/i18n"

export default function SystemMessage(props: {
  part: Extract<ClientPart, { type: "system" }>
  visibility: VisibilityPreference
  activeSearchMatch?: boolean
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  createEffect(() => setExpanded(props.visibility === "expanded"))
  createEffect(() => { if (props.activeSearchMatch) setExpanded(true) })
  return (
    <Show when={props.visibility !== "hidden"}>
      <section class="border border-base bg-surface-secondary text-secondary" data-message-kind="system" aria-label={t("messageBlock.system.label")}>
        <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs" aria-expanded={expanded()}
          onClick={() => setExpanded(value => !value)}>
          <Info class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span class="shrink-0 font-medium">{t("messageBlock.system.label")}</span>
          <Show when={props.part.description}><span class="min-w-0 flex-1 truncate">{props.part.description}</span></Show>
          <ChevronRight class={`ml-auto w-3.5 h-3.5 shrink-0 ${expanded() ? "rotate-90" : ""}`} aria-hidden="true" />
        </button>
        <Show when={expanded()}>
          <pre class="message-text m-0 max-h-96 overflow-auto border-t border-base bg-surface-base p-3 whitespace-pre-wrap break-words font-mono text-xs" data-part-type="system" data-part-id={props.part.id} dir="auto">{props.part.text}</pre>
        </Show>
      </section>
    </Show>
  )
}
