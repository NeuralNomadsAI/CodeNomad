type GlobalPointerDragHandlers = {
  onMouseMove: (event: MouseEvent) => void
  onMouseUp: (event: MouseEvent) => void
  onTouchMove: (event: TouchEvent) => void
  onTouchEnd: (event: TouchEvent) => void
}

type GlobalPointerDrag = {
  start: () => void
  stop: () => void
}

export function useGlobalPointerDrag(handlers: GlobalPointerDragHandlers): GlobalPointerDrag {
  const start = () => {
    document.addEventListener("mousemove", handlers.onMouseMove)
    document.addEventListener("mouseup", handlers.onMouseUp)
    document.addEventListener("touchmove", handlers.onTouchMove, { passive: false })
    document.addEventListener("touchend", handlers.onTouchEnd)
  }

  const stop = () => {
    document.removeEventListener("mousemove", handlers.onMouseMove)
    document.removeEventListener("mouseup", handlers.onMouseUp)
    document.removeEventListener("touchmove", handlers.onTouchMove)
    document.removeEventListener("touchend", handlers.onTouchEnd)
  }

  return { start, stop }
}
