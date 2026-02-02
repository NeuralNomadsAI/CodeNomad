import { createSignal, onCleanup, onMount } from "solid-js"

export interface SafeAreaInsets {
  top: number
  bottom: number
}

/**
 * Returns reactive safe-area inset values from CSS env().
 * Falls back to 0 on non-notched devices.
 */
export function useSafeArea() {
  const [insets, setInsets] = createSignal<SafeAreaInsets>({ top: 0, bottom: 0 })

  onMount(() => {
    if (typeof document === "undefined") return

    const probe = document.createElement("div")
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden;"
    document.body.appendChild(probe)

    const measure = () => {
      const style = getComputedStyle(probe)
      setInsets({
        top: parseFloat(style.paddingTop) || 0,
        bottom: parseFloat(style.paddingBottom) || 0,
      })
    }

    measure()

    // Re-measure on orientation changes
    const mql = window.matchMedia("(orientation: portrait)")
    const handler = () => requestAnimationFrame(measure)
    mql.addEventListener("change", handler)

    onCleanup(() => {
      mql.removeEventListener("change", handler)
      probe.remove()
    })
  })

  return insets
}
