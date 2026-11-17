import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useI18n } from "../lib/i18n"
import { renderMermaid } from "../lib/mermaid-renderer"
import { BoundedText } from "./hidden-text"

export function MermaidDiagram(props: {
  code: string; isDark?: boolean; showSourceOnError?: boolean; onReady?: (ready: boolean) => void; onRendered?: () => void
}) {
  const { t } = useI18n()
  const [image, setImage] = createSignal<string>()
  const [failed, setFailed] = createSignal(false)
  createEffect(() => {
    const controller = new AbortController()
    setImage(undefined); setFailed(false); props.onReady?.(false)
    void renderMermaid(props.code, Boolean(props.isDark), controller.signal).then(value => {
      if (controller.signal.aborted) return
      setImage(value); props.onReady?.(true)
    }).catch(() => {
      if (!controller.signal.aborted) { setFailed(true); props.onRendered?.() }
    })
    onCleanup(() => controller.abort())
  })
  return <div class="mermaid-diagram">
    <Show when={failed()}><p class="mermaid-error" role="alert">{t("markdown.mermaid.failed")}</p></Show>
    <Show when={failed() && props.showSourceOnError}><BoundedText source={props.code}>{text => <pre>{text()}</pre>}</BoundedText></Show>
    <Show when={image()}>{src => <img src={src()} alt={t("markdown.mermaid.diagram")} onLoad={() => props.onRendered?.()}
      onError={event => {
        if (event.currentTarget.getAttribute("src") !== image()) return
        setImage(undefined); setFailed(true); props.onReady?.(false); props.onRendered?.()
      }} />}</Show>
    <Show when={!image() && !failed()}><span class="mermaid-loading" role="status">{t("instanceInfo.loading")}</span></Show>
  </div>
}
