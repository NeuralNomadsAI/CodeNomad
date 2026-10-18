import { onCleanup } from "solid-js"

/** Width of a flex row laid out on one line: its children, gaps and padding. */
function naturalWidth(row: HTMLElement): number {
  const style = getComputedStyle(row), items = [...row.children] as HTMLElement[]
  const gap = parseFloat(style.columnGap) || 0
  return items.reduce((width, item) => width + item.getBoundingClientRect().width, 0)
    + gap * Math.max(0, items.length - 1) + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
}

/**
 * Reports whether the palette swatch strip still fits on the picker line at its
 * natural width. Measured rather than a fixed breakpoint, because the actions
 * beside it change with the selected palette and unsaved edits.
 */
export function observePaletteStripFit(workbench: HTMLElement, actions: HTMLElement, onStacked: (stacked: boolean) => void) {
  const measure = () => {
    const strip = workbench.querySelector<HTMLElement>(".theme-scheme-swatches")
    if (!strip) return onStacked(false)
    const columnGap = parseFloat(getComputedStyle(workbench).columnGap) || 0
    // The picker keeps the 6rem minimum of its grid column when sharing the line (rem: root size).
    const pickerMinimum = 6 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)
    onStacked(pickerMinimum + naturalWidth(strip) + naturalWidth(actions) + 2 * columnGap > workbench.clientWidth)
  }
  const observer = new ResizeObserver(measure)
  observer.observe(workbench)
  observer.observe(actions)
  // Buttons appear and disappear with edits without always resizing the row.
  const mutations = new MutationObserver(measure)
  mutations.observe(actions, { childList: true })
  onCleanup(() => { observer.disconnect(); mutations.disconnect() })
}
