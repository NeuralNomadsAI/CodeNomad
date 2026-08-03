import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

import { writeClientLayoutValue } from "../../../../../stores/client-state"
import { readStoredPanelWidth } from "../../storage"
import { useGlobalPointerDrag } from "../../useGlobalPointerDrag"

interface SplitResizeOptions {
  storageKey: string
  defaultWidth: number
  rightDrawerWidth: Accessor<number>
  rightDrawerWidthInitialized: Accessor<boolean>
}

export function createSplitResize(options: SplitResizeOptions) {
  const [splitWidth, setSplitWidth] = createSignal(options.defaultWidth)
  const [initialized, setInitialized] = createSignal(false)
  const [active, setActive] = createSignal(false)
  const [startX, setStartX] = createSignal(0)
  const [startWidth, setStartWidth] = createSignal(0)

  const clampSplitWidth = (value: number) => {
    const min = 200
    const maxByDrawer = Math.max(min, Math.floor(options.rightDrawerWidth() * 0.65))
    const max = Math.min(560, maxByDrawer)
    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  createEffect(() => {
    if (initialized()) return
    if (!options.rightDrawerWidthInitialized()) return
    setInitialized(true)
    setSplitWidth(clampSplitWidth(readStoredPanelWidth(options.storageKey, options.defaultWidth)))
  })

  const persistSplitWidth = () => {
    writeClientLayoutValue(options.storageKey, String(splitWidth()))
  }

  function stopResize() {
    setActive(false)
    if (typeof document === "undefined") return
    pointerDrag.stop()
  }

  function move(clientX: number) {
    if (!active()) return
    const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl"
    const delta = (clientX - startX()) * (isRtl ? -1 : 1)
    setSplitWidth(clampSplitWidth(startWidth() + delta))
  }

  const pointerDrag = useGlobalPointerDrag({
    onMouseMove: (event) => {
      if (!active()) return
      event.preventDefault()
      move(event.clientX)
    },
    onMouseUp: () => {
      if (active()) persistSplitWidth()
      stopResize()
    },
    onTouchMove: (event) => {
      if (!active()) return
      const touch = event.touches[0]
      if (!touch) return
      event.preventDefault()
      move(touch.clientX)
    },
    onTouchEnd: () => {
      if (active()) persistSplitWidth()
      stopResize()
    },
  })

  const startResize = (clientX: number) => {
    if (typeof document === "undefined") return
    setActive(true)
    setStartX(clientX)
    setStartWidth(splitWidth())
    pointerDrag.start()
  }

  onCleanup(stopResize)

  return {
    splitWidth,
    onResizeMouseDown: (event: MouseEvent) => {
      event.preventDefault()
      startResize(event.clientX)
    },
    onResizeTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      event.preventDefault()
      startResize(touch.clientX)
    },
  }
}
