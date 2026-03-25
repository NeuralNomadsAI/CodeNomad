import { onCleanup } from "solid-js"

interface UseLongPressOptions {
  onLongPress: (e: PointerEvent) => void
  delay?: number
  jitterThreshold?: number
}

export function useLongPress(options: UseLongPressOptions) {
  const delay = options.delay ?? 500
  const jitterThreshold = options.jitterThreshold ?? 10
  
  let timer: number | null = null
  let wasLongPress = false
  let startPos = { x: 0, y: 0 }

  const clearTimer = () => {
    if (timer !== null && typeof window !== "undefined") {
      window.clearTimeout(timer)
      timer = null
    }
  }

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    wasLongPress = false
    startPos = { x: e.clientX, y: e.clientY }
    clearTimer()

    if (typeof window !== "undefined") {
      timer = window.setTimeout(() => {
        timer = null
        wasLongPress = true
        options.onLongPress(e)
      }, delay)
    }
  }

  const handlePointerMove = (e: PointerEvent) => {
    if (timer !== null) {
      const dist = Math.sqrt(
        Math.pow(e.clientX - startPos.x, 2) + Math.pow(e.clientY - startPos.y, 2)
      )
      if (dist > jitterThreshold) {
        clearTimer()
      }
    }
  }

  const handlePointerUp = () => {
    clearTimer()
  }

  onCleanup(clearTimer)

  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerUp,
    get wasLongPress() { return wasLongPress },
    resetWasLongPress() { wasLongPress = false }
  }
}
