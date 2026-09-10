import { onCleanup, onMount, type ParentComponent } from "solid-js"

/** Native scrollbar above upright tabs. Both scrollers use the same logical
 * scrollLeft (including negative RTL offsets); no mirrored compositing layer. */
const TabScroll: ParentComponent = (props) => {
  let viewport!: HTMLDivElement
  let scrollbar!: HTMLDivElement
  let extent!: HTMLDivElement
  let content!: HTMLDivElement

  onMount(() => {
    const measure = () => {
      // scrollWidth is integer-rounded, while the two boxes can be fractional
      // at browser zoom. Copying it can manufacture overflow in the top lane.
      // Keep a fitting extent relative, and preserve subpixels when overflowing.
      const overflowing = viewport.scrollWidth > viewport.clientWidth
      extent.style.width = overflowing ? getComputedStyle(content).width : "100%"
      scrollbar.style.overflowX = overflowing ? "auto" : "hidden"
      scrollbar.scrollLeft = viewport.scrollLeft
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)
    measure()
    onCleanup(() => observer.disconnect())
  })

  return (
    <div class="tab-scroll-frame">
      <div class="tab-scrollbar" ref={scrollbar} aria-hidden="true" tabIndex={-1}
        onScroll={() => { if (viewport.scrollLeft !== scrollbar.scrollLeft) viewport.scrollLeft = scrollbar.scrollLeft }}>
        <div ref={extent} class="tab-scrollbar-extent" />
      </div>
      <div class="tab-scroll" ref={viewport}
        onScroll={() => { if (scrollbar.scrollLeft !== viewport.scrollLeft) scrollbar.scrollLeft = viewport.scrollLeft }}>
        <div class="tab-strip" ref={content}>{props.children}</div>
      </div>
    </div>
  )
}

export default TabScroll
