import { createSignal, onCleanup, type Accessor, type Setter } from "solid-js"

import { useGlobalPointerDrag } from "./useGlobalPointerDrag"

type DrawerResizeSide = "left" | "right"

type DrawerResizeOptions = {
  sessionSidebarWidth: Accessor<number>
  rightDrawerWidth: Accessor<number>
  setSessionSidebarWidth: Setter<number>
  setRightDrawerWidth: Setter<number>
  clampLeft: (width: number) => number
  clampRight: (width: number) => number
  measureDrawerHost: () => void
}

type DrawerResizeApi = {
  handleDrawerResizeMouseDown: (side: DrawerResizeSide) => (event: MouseEvent) => void
  handleDrawerResizeTouchStart: (side: DrawerResizeSide) => (event: TouchEvent) => void
}

export function useDrawerResize(options: DrawerResizeOptions): DrawerResizeApi {
  const [activeResizeSide, setActiveResizeSide] = createSignal<DrawerResizeSide | null>(null)
  const [resizeStartX, setResizeStartX] = createSignal(0)
  const [resizeStartWidth, setResizeStartWidth] = createSignal(0)

  const scheduleDrawerMeasure = () => {
    if (typeof window === "undefined") {
      options.measureDrawerHost()
      return
    }
    requestAnimationFrame(() => options.measureDrawerHost())
  }

  const applyDrawerWidth = (side: DrawerResizeSide, width: number) => {
    if (side === "left") {
      options.setSessionSidebarWidth(width)
    } else {
      options.setRightDrawerWidth(width)
    }
    scheduleDrawerMeasure()
  }

  const handleDrawerPointerMove = (clientX: number) => {
    const side = activeResizeSide()
    if (!side) return
    const startWidth = resizeStartWidth()
    const clamp = side === "left" ? options.clampLeft : options.clampRight
    const delta = side === "left" ? clientX - resizeStartX() : resizeStartX() - clientX
    const nextWidth = clamp(startWidth + delta)
    applyDrawerWidth(side, nextWidth)
  }

  function drawerMouseMove(event: MouseEvent) {
    event.preventDefault()
    handleDrawerPointerMove(event.clientX)
  }

  function drawerMouseUp() {
    stopDrawerResize()
  }

  function drawerTouchMove(event: TouchEvent) {
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    handleDrawerPointerMove(touch.clientX)
  }

  function drawerTouchEnd() {
    stopDrawerResize()
  }

  const drawerPointerDrag = useGlobalPointerDrag({
    onMouseMove: drawerMouseMove,
    onMouseUp: drawerMouseUp,
    onTouchMove: drawerTouchMove,
    onTouchEnd: drawerTouchEnd,
  })

  function stopDrawerResize() {
    setActiveResizeSide(null)
    drawerPointerDrag.stop()
  }

  const startDrawerResize = (side: DrawerResizeSide, clientX: number) => {
    setActiveResizeSide(side)
    setResizeStartX(clientX)
    setResizeStartWidth(side === "left" ? options.sessionSidebarWidth() : options.rightDrawerWidth())
    drawerPointerDrag.start()
  }

  const handleDrawerResizeMouseDown = (side: DrawerResizeSide) => (event: MouseEvent) => {
    event.preventDefault()
    startDrawerResize(side, event.clientX)
  }

  const handleDrawerResizeTouchStart = (side: DrawerResizeSide) => (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    startDrawerResize(side, touch.clientX)
  }

  onCleanup(() => {
    stopDrawerResize()
  })

  return {
    handleDrawerResizeMouseDown,
    handleDrawerResizeTouchStart,
  }
}
