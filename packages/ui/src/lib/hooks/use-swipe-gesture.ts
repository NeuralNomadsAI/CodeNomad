import { onCleanup } from "solid-js"

interface SwipeGestureOptions {
  onSwipeLeft?: (velocity: number) => void
  onSwipeRight?: (velocity: number) => void
  onSwipeProgress?: (deltaX: number) => void
  onSwipeEnd?: () => void
  threshold?: number
  velocityThreshold?: number
  angleThreshold?: number
}

/**
 * Attaches horizontal swipe detection to an element.
 * Ignores vertical scrolling (angle > angleThreshold degrees from horizontal).
 * Calls onSwipeLeft/onSwipeRight when a swipe exceeds the distance threshold
 * or the velocity threshold on touchend.
 */
export function useSwipeGesture(
  getElement: () => HTMLElement | undefined,
  options: SwipeGestureOptions,
) {
  const threshold = options.threshold ?? 50
  const velocityThreshold = options.velocityThreshold ?? 0.5
  const angleThreshold = options.angleThreshold ?? 30

  let startX = 0
  let startY = 0
  let startTime = 0
  let tracking = false
  let directionLocked: "horizontal" | "vertical" | null = null

  function handleTouchStart(e: TouchEvent) {
    const touch = e.touches[0]
    if (!touch) return
    startX = touch.clientX
    startY = touch.clientY
    startTime = Date.now()
    tracking = true
    directionLocked = null
  }

  function handleTouchMove(e: TouchEvent) {
    if (!tracking) return
    const touch = e.touches[0]
    if (!touch) return

    const deltaX = touch.clientX - startX
    const deltaY = touch.clientY - startY

    if (!directionLocked) {
      const absDx = Math.abs(deltaX)
      const absDy = Math.abs(deltaY)
      // Need some movement before locking direction
      if (absDx < 5 && absDy < 5) return

      const angleDeg = Math.atan2(absDy, absDx) * (180 / Math.PI)
      if (angleDeg > angleThreshold) {
        directionLocked = "vertical"
        tracking = false
        return
      }
      directionLocked = "horizontal"
    }

    if (directionLocked === "horizontal") {
      // Prevent vertical scroll while swiping horizontally
      e.preventDefault()
      options.onSwipeProgress?.(deltaX)
    }
  }

  function handleTouchEnd(e: TouchEvent) {
    if (!tracking || directionLocked !== "horizontal") {
      tracking = false
      directionLocked = null
      return
    }

    const touch = e.changedTouches[0]
    if (!touch) {
      tracking = false
      return
    }

    const deltaX = touch.clientX - startX
    const elapsed = (Date.now() - startTime) / 1000
    const velocity = elapsed > 0 ? Math.abs(deltaX) / elapsed : 0
    const absDeltaX = Math.abs(deltaX)

    const isFastSwipe = velocity >= velocityThreshold * 1000
    const isLongSwipe = absDeltaX >= threshold

    if (isFastSwipe || isLongSwipe) {
      if (deltaX < 0) {
        options.onSwipeLeft?.(velocity)
      } else {
        options.onSwipeRight?.(velocity)
      }
    }

    options.onSwipeEnd?.()
    tracking = false
    directionLocked = null
  }

  // Attach listeners after mount
  setTimeout(() => {
    const el = getElement()
    if (!el) return

    el.addEventListener("touchstart", handleTouchStart, { passive: true })
    el.addEventListener("touchmove", handleTouchMove, { passive: false })
    el.addEventListener("touchend", handleTouchEnd, { passive: true })

    onCleanup(() => {
      el.removeEventListener("touchstart", handleTouchStart)
      el.removeEventListener("touchmove", handleTouchMove)
      el.removeEventListener("touchend", handleTouchEnd)
    })
  }, 0)
}
