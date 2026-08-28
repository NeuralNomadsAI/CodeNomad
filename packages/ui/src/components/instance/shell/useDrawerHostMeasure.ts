import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

type DrawerHostMeasure = {
  setDrawerHost: (element: HTMLElement) => void
  drawerContainer: () => HTMLElement | undefined
  drawerHostWidth: Accessor<number>
  measureDrawerHost: () => void
}

export function useDrawerHostMeasure(): DrawerHostMeasure {
  const [drawerHost, setDrawerHost] = createSignal<HTMLElement | null>(null)
  const [drawerHostWidth, setDrawerHostWidth] = createSignal(typeof window === "undefined" ? 0 : window.innerWidth)

  const storeDrawerHost = (element: HTMLElement) => {
    setDrawerHost(element)
  }

  const measureDrawerHost = () => {
    if (typeof window === "undefined") return
    const host = drawerHost()
    if (!host) return
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0) return
    setDrawerHostWidth(rect.width)
  }

  createEffect(() => {
    const host = drawerHost()
    if (!host || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measureDrawerHost)
    observer.observe(host)
    onCleanup(() => observer.disconnect())
  })

  const drawerContainer = () => {
    const host = drawerHost()
    if (host) return host
    if (typeof document !== "undefined") {
      return document.body
    }
    return undefined
  }

  return {
    setDrawerHost: storeDrawerHost,
    drawerContainer,
    drawerHostWidth,
    measureDrawerHost,
  }
}
