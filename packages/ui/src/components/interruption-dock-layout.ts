import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

// A percentage cap cannot fit even the fixed chrome under a very short keyboard
// viewport. Preserve one usable control between the measured header/footer;
// the session's outer scroller then makes each part of the stack reachable.
export function useInterruptionMinimumHeight(root: Accessor<HTMLElement | undefined>, request: Accessor<string | undefined>) {
  const [minimum, setMinimum] = createSignal<number>()
  createEffect(() => {
    if (!request()) return
    let disposed = false
    let observer: ResizeObserver | undefined
    queueMicrotask(() => {
      if (disposed) return
      const section = root()
      const header = section?.querySelector<HTMLElement>(".window-header")
      const editor = section?.querySelector<HTMLElement>(".interruption-editor:not([hidden])")
      const footer = editor?.querySelector<HTMLElement>(".window-footer")
      const fields = editor?.querySelector<HTMLElement>(".form-request-fields, .interruption-permission-content")
      if (!section || !header || !editor || !footer || !fields) return
      const control = fields.querySelector<HTMLElement>("input, textarea, select, [role=radio]")
      const measure = () => {
        const style = getComputedStyle(section), fieldStyle = getComputedStyle(fields)
        const controlHeight = Math.max(parseFloat(style.getPropertyValue("--touch-target-size")) || 0, control?.getBoundingClientRect().height ?? 0)
        const fieldHeight = controlHeight + parseFloat(fieldStyle.paddingTop) + parseFloat(fieldStyle.paddingBottom)
        const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
        const error = editor.querySelector<HTMLElement>(".form-request-error, .tool-call-permission-error")?.getBoundingClientRect().height ?? 0
        setMinimum(Math.ceil(header.getBoundingClientRect().height + footer.getBoundingClientRect().height + fieldHeight + border + error))
      }
      observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
      for (const element of [section, header, footer, fields, ...(control ? [control] : [])]) observer?.observe(element)
      measure()
    })
    onCleanup(() => { disposed = true; observer?.disconnect() })
  })
  return minimum
}
