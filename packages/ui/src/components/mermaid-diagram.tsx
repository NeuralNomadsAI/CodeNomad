import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useI18n } from "../lib/i18n"
import { renderMermaid } from "../lib/mermaid-renderer"
import { BoundedText } from "./hidden-text"
import { useOptionalTheme } from "../lib/theme"
import { createCssColorResolver } from "../lib/css-color"
import type { MermaidAppearance } from "../lib/mermaid-renderer"

export function MermaidDiagram(props: {
  code: string; isDark?: boolean; showSourceOnError?: boolean; onReady?: (ready: boolean) => void; onRendered?: () => void
}) {
  const { t } = useI18n()
  const theme = useOptionalTheme()
  const [image, setImage] = createSignal<string>()
  const [failed, setFailed] = createSignal(false)
  let previousCode: string | undefined
  createEffect(() => {
    theme?.themeRevision()
    let appearance: MermaidAppearance | undefined
    if (theme) {
      const colors = createCssColorResolver()
      try {
        appearance = {
          background: colors.resolve("--surface-canvas", "background"),
          surface: colors.resolve("--surface-inset", "background"),
          secondary: colors.resolve("--surface-control", "background"),
          text: colors.resolve("--text-primary", "foreground"),
          border: colors.resolve("--accent-text", "foreground"),
          error: colors.resolve("--status-error", "foreground"),
        }
      } finally { colors.dispose() }
    }
    const controller = new AbortController()
    if (props.code !== previousCode) {
      previousCode = props.code
      setImage(undefined); props.onReady?.(false)
    }
    setFailed(false)
    void renderMermaid(props.code, props.isDark ?? theme?.isDark() ?? false, controller.signal, appearance).then(value => {
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
