import { createEffect, createSignal, type Accessor } from "solid-js"

type DrawerHostMeasure = {
  setDrawerHost: (element: HTMLElement) => void
  drawerContainer: () => HTMLElement | undefined
  measureDrawerHost: () => void
  floatingTopPx: () => string
  floatingHeight: () => string
}

export function useDrawerHostMeasure(tabBarOffset: Accessor<number>): DrawerHostMeasure {
  const [drawerHost, setDrawerHost] = createSignal<HTMLElement | null>(null)
  const [floatingDrawerTop, setFloatingDrawerTop] = createSignal(0)
  const [floatingDrawerHeight, setFloatingDrawerHeight] = createSignal(0)

  const storeDrawerHost = (element: HTMLElement) => {
    setDrawerHost(element)
  }

  const measureDrawerHost = () => {
    if (typeof window === "undefined") return
    const host = drawerHost()
    if (!host) return
    const rect = host.getBoundingClientRect()
    setFloatingDrawerTop(rect.top)
    setFloatingDrawerHeight(Math.max(0, rect.height))
  }

  createEffect(() => {
    tabBarOffset()
    if (typeof window === "undefined") return
    requestAnimationFrame(() => measureDrawerHost())
  })

  const drawerContainer = () => {
    const host = drawerHost()
    if (host) return host
    if (typeof document !== "undefined") {
      return document.body
    }
    return undefined
  }

  const fallbackDrawerTop = () => tabBarOffset()
  const floatingTop = () => {
    const measured = floatingDrawerTop()
    if (measured > 0) return measured
    return fallbackDrawerTop()
  }

  const floatingTopPx = () => `${floatingTop()}px`
  const floatingHeight = () => {
    const measured = floatingDrawerHeight()
    if (measured > 0) return `${measured}px`
    return `calc(100% - ${floatingTop()}px)`
  }

  return {
    setDrawerHost: storeDrawerHost,
    drawerContainer,
    measureDrawerHost,
    floatingTopPx,
    floatingHeight,
  }
}
