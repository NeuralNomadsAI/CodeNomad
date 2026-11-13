import { createEffect, getOwner, onCleanup, runWithOwner, type Accessor } from "solid-js"
import { render } from "solid-js/web"
import { useI18n } from "../lib/i18n"
import { MermaidDiagram } from "./mermaid-diagram"
import type { MermaidCodeBlock } from "../types/message"

/** Adds only Mermaid's view control; the Markdown source and copy/wrap controls keep their identity. */
export function useMarkdownMermaid(options: {
  root: () => HTMLElement | undefined; html: Accessor<string>; identity: Accessor<string>
  blocks: Accessor<MermaidCodeBlock[]>
  dark: Accessor<boolean>; streaming: Accessor<boolean>; onRendered: () => void
}) {
  const { t } = useI18n()
  const owner = getOwner()
  const modes = new Map<string, boolean>()
  let cleanups: Array<() => void> = []
  let disposed = false, queued = false
  let identity = ""
  const clear = () => { for (const cleanup of cleanups) cleanup(); cleanups = [] }
  const sync = () => {
    queued = false
    clear()
    const root = options.root()
    if (disposed || !root) return
    if (identity !== options.identity()) { identity = options.identity(); modes.clear() }
    const dark = options.dark(), streaming = options.streaming()
    for (const entry of options.blocks()) {
      if (!entry.complete) continue
      const block = root.querySelector<HTMLElement>(`[data-mermaid-token="${entry.token}"]`)
      if (!block || block.dataset.code !== entry.code) continue
      const source = block.querySelector<HTMLElement>(":scope > pre")
      const actions = block.querySelector(".code-block-actions")
      if (!source || !actions || !block.dataset.code) continue
      const key = block.dataset.codeBlockKey ?? block.dataset.code
      const button = document.createElement("button")
      button.type = "button"
      button.className = "code-block-diagram icon-toggle"
      button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="2" width="8" height="5"/><path d="M12 7v5M4 12h16M4 12v5M20 12v5"/><rect x="1" y="17" width="6" height="5"/><rect x="17" y="17" width="6" height="5"/></svg>'
      const host = document.createElement("div")
      host.className = "markdown-mermaid-preview"
      let ready = false
      let preview = modes.get(key) ?? true
      const display = () => {
        const show = preview && ready
        source.hidden = show
        host.hidden = !preview
        button.setAttribute("aria-pressed", String(show))
        button.title = button.ariaLabel = t(show ? "markdown.mermaid.source" : "markdown.mermaid.preview")
      }
      button.disabled = streaming
      actions.prepend(button)
      block.append(host)
      button.onclick = () => { preview = !preview; modes.set(key, preview); display(); options.onRendered() }
      let dispose: (() => void) | undefined
      if (!streaming) {
        let code = ""
        try { code = decodeURIComponent(entry.code) } catch { /* Invalid encoded blocks retain their source. */ }
        dispose = runWithOwner(owner, () => render(() => <MermaidDiagram code={code} isDark={dark} onReady={value => {
          ready = value; display()
        }} onRendered={options.onRendered} />, host))
      } else host.hidden = true
      display()
      if (streaming) host.hidden = true
      cleanups.push(() => { dispose?.(); source.hidden = false; button.remove(); host.remove() })
    }
  }
  createEffect(() => {
    options.html(); options.blocks(); options.dark(); options.streaming(); options.identity()
    if (!queued) { queued = true; queueMicrotask(sync) }
  })
  onCleanup(() => { disposed = true; clear() })
}
