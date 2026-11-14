import { createSignal, onCleanup, type Accessor, type Setter } from "solid-js"

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
  activeResizeSide: Accessor<DrawerResizeSide | null>
  handleDrawerResizePointerDown: (side: DrawerResizeSide) => (event: PointerEvent) => void
  handleDrawerResizePointerMove: (event: PointerEvent) => void
  handleDrawerResizePointerEnd: (event: PointerEvent) => void
  stopDrawerResize: () => void
}

export function useDrawerResize(options: DrawerResizeOptions): DrawerResizeApi {
  const [activeResizeSide, setActiveResizeSide] = createSignal<DrawerResizeSide | null>(null)
  const [resizeStartX, setResizeStartX] = createSignal(0)
  const [resizeStartWidth, setResizeStartWidth] = createSignal(0)
  let resizePointerId: number | undefined

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
    const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl"
    const rawDelta = side === "left" ? clientX - resizeStartX() : resizeStartX() - clientX
    const delta = isRtl ? -rawDelta : rawDelta
    const nextWidth = clamp(startWidth + delta)
    applyDrawerWidth(side, nextWidth)
  }

  function stopDrawerResize() {
    resizePointerId = undefined
    setActiveResizeSide(null)
  }

  function handleDrawerResizePointerMove(event: PointerEvent) {
    if (event.pointerId !== resizePointerId) return
    event.preventDefault()
    handleDrawerPointerMove(event.clientX)
  }

  function handleDrawerResizePointerEnd(event: PointerEvent) {
    if (event.pointerId !== resizePointerId) return
    stopDrawerResize()
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  const handleDrawerResizePointerDown = (side: DrawerResizeSide) => (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || resizePointerId !== undefined) return
    event.preventDefault()
    resizePointerId = event.pointerId
    setActiveResizeSide(side)
    setResizeStartX(event.clientX)
    setResizeStartWidth(side === "left" ? options.sessionSidebarWidth() : options.rightDrawerWidth())
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    } catch {
      stopDrawerResize()
    }
  }

  onCleanup(() => {
    stopDrawerResize()
  })

  return {
    activeResizeSide,
    handleDrawerResizePointerDown,
    handleDrawerResizePointerMove,
    handleDrawerResizePointerEnd,
    stopDrawerResize,
  }
}
