import { For, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"

export interface TimelineListHandle {
  scrollToIndex: (index: number) => void
}

/** Timeline markers have known geometry, unlike transcript messages. Measure
 * the two CSS primitives once and give the native scrollbar the exact extent,
 * including offscreen group gaps. No estimated or zero-height hidden rows. */
export default function TimelineVirtualList<T>(props: {
  items: T[]
  gap: (item: T) => number
  scrollElement?: HTMLDivElement
  register: (handle: TimelineListHandle) => void
  onVisibleItems?: (items: T[]) => void
  children: (item: T) => JSX.Element
}) {
  const [size, setSize] = createSignal({ marker: 20, gap: 5.6 })
  const [viewport, setViewport] = createSignal({ top: 0, height: 0 })
  let marker!: HTMLButtonElement
  let gap!: HTMLDivElement
  const layout = createMemo(() => {
    const geometry = size()
    let extent = 0
    const rows = props.items.map(item => {
      const space = props.gap(item) * geometry.gap
      const top = extent
      extent += geometry.marker + space
      return { item, top, space, height: geometry.marker + space }
    })
    return { rows, extent }
  })
  const visible = createMemo(() => {
    const { rows } = layout(), { top, height } = viewport()
    let low = 0, high = rows.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (rows[middle].top + rows[middle].height < top - 240) low = middle + 1
      else high = middle
    }
    const start = low
    while (low < rows.length && rows[low].top < top + height + 240) low++
    return rows.slice(start, low).map(row => row.item)
  })
  const byItem = createMemo(() => new Map(layout().rows.map(row => [row.item, row])))
  createEffect(() => props.onVisibleItems?.(visible()))
  createEffect(() => {
    const element = props.scrollElement
    if (!element) return
    const readViewport = () => setViewport({ top: element.scrollTop, height: element.clientHeight })
    const measure = () => {
      const next = { marker: parseFloat(getComputedStyle(marker).height), gap: parseFloat(getComputedStyle(gap).height) }
      if (next.marker > 0 && (next.marker !== size().marker || next.gap !== size().gap)) setSize(next)
      readViewport()
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(marker)
    observer.observe(gap)
    element.addEventListener("scroll", readViewport, { passive: true })
    measure()
    onCleanup(() => { observer.disconnect(); element.removeEventListener("scroll", readViewport) })
  })
  props.register({ scrollToIndex: index => {
    const element = props.scrollElement, row = layout().rows[index]
    if (!element || !row) return
    if (row.top < element.scrollTop) element.scrollTop = row.top
    else if (row.top + row.height > element.scrollTop + element.clientHeight) {
      element.scrollTop = row.top + row.height - element.clientHeight
    }
    setViewport({ top: element.scrollTop, height: element.clientHeight })
  } })
  return <>
    <div class="timeline-measure" aria-hidden="true" inert>
      <button ref={marker} class="message-timeline-segment" tabIndex={-1} />
      <div ref={gap} style={{ height: "var(--message-timeline-segment-gap)" }} />
    </div>
    <div class="timeline-virtual-content"
      data-overflow={viewport().height > 0 && Math.round(layout().extent) > viewport().height ? "true" : undefined}
      style={{ height: `${layout().extent}px` }}>
      <For each={visible()}>{item => <div class="timeline-virtual-row" style={{
        top: `${byItem().get(item)!.top}px`, height: `${byItem().get(item)!.height}px`,
        "padding-top": `${byItem().get(item)!.space}px`,
      }}>{props.children(item)}</div>}</For>
    </div>
  </>
}
