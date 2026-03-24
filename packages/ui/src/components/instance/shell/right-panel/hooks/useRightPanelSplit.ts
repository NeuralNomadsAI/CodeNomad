import { createSignal, createEffect, onCleanup, type Accessor } from "solid-js"
import { readStoredPanelWidth } from "../../storage"
import { useGlobalPointerDrag } from "../../useGlobalPointerDrag"

export function useRightPanelSplit(props: {
  rightDrawerWidth: Accessor<number>
  rightDrawerWidthInitialized: Accessor<boolean>
}) {
  const [activeSplitResize, setActiveSplitResize] = createSignal<string | null>(null)
  const [splitResizeStartX, setSplitResizeStartX] = createSignal(0)
  const [splitResizeStartWidth, setSplitResizeStartWidth] = createSignal(0)
  const [splitWidthsInitialized, setSplitWidthsInitialized] = createSignal(false)

  let activeCallbacks: { onMove: (w: number) => void; onEnd: () => void } | null = null

  const clampSplitWidth = (value: number) => {
    const min = 200
    const maxByDrawer = Math.max(min, Math.floor(props.rightDrawerWidth() * 0.65))
    const max = Math.min(560, maxByDrawer)
    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  createEffect(() => {
    if (!props.rightDrawerWidthInitialized()) return
    setSplitWidthsInitialized(true)
  })

  function stopSplitResize() {
    setActiveSplitResize(null)
    if (typeof document !== "undefined") splitPointerDrag.stop()
  }

  const splitPointerDrag = useGlobalPointerDrag({
    onMouseMove: (event) => {
      event.preventDefault()
      const delta = event.clientX - splitResizeStartX()
      activeCallbacks?.onMove(clampSplitWidth(splitResizeStartWidth() + delta))
    },
    onMouseUp: () => {
      activeCallbacks?.onEnd()
      stopSplitResize()
    },
    onTouchMove: (event) => {
      const touch = event.touches[0]
      if (!touch) return
      event.preventDefault()
      const delta = touch.clientX - splitResizeStartX()
      activeCallbacks?.onMove(clampSplitWidth(splitResizeStartWidth() + delta))
    },
    onTouchEnd: () => {
      activeCallbacks?.onEnd()
      stopSplitResize()
    },
  })

  onCleanup(stopSplitResize)

  const createPanelSplit = (storageKey: string, id: string) => {
    const [width, setWidth] = createSignal(320)

    createEffect(() => {
      if (splitWidthsInitialized()) {
        setWidth(clampSplitWidth(readStoredPanelWidth(storageKey, 320)))
      }
    })

    const persistWidth = (w: number) => {
      if (typeof window !== "undefined") window.localStorage.setItem(storageKey, String(w))
    }

    const startResize = (clientX: number) => {
      if (typeof document === "undefined") return
      setActiveSplitResize(id)
      setSplitResizeStartX(clientX)
      setSplitResizeStartWidth(width())
      
      activeCallbacks = {
        onMove: setWidth,
        onEnd: () => persistWidth(width())
      }
      splitPointerDrag.start()
    }

    return {
      width,
      handleMouseDown: (event: MouseEvent) => {
        event.preventDefault()
        startResize(event.clientX)
      },
      handleTouchStart: (event: TouchEvent) => {
        const touch = event.touches[0]
        if (!touch) return
        event.preventDefault()
        startResize(touch.clientX)
      }
    }
  }

  return { createPanelSplit }
}
