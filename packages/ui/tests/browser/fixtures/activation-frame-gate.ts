// Hold only SessionView's final activation-focus frame. Transcript/layout frames
// keep running, and native frame IDs/cancellation retain their normal meaning.
export function installActivationFrameGate() {
  const request = window.requestAnimationFrame.bind(window)
  const cancel = window.cancelAnimationFrame.bind(window)
  const held = new Map<number, { callback: FrameRequestCallback; cancelled: boolean }>()
  let paused = false
  window.requestAnimationFrame = callback => {
    if (!paused || callback.name !== "focusActivatedSession") return request(callback)
    const id = request(() => {})
    held.set(id, { callback, cancelled: false })
    return id
  }
  window.cancelAnimationFrame = id => {
    const entry = held.get(id)
    if (entry) entry.cancelled = true
    cancel(id)
  }
  return {
    pause: () => { paused = true },
    pending: () => [...held.values()].filter(entry => !entry.cancelled).length,
    cancelled: () => [...held.values()].filter(entry => entry.cancelled).length,
    flush: (cancelledOnly = false) => {
      for (const [id, entry] of [...held]) {
        if (cancelledOnly && !entry.cancelled) continue
        held.delete(id)
        cancel(id)
        // Explicitly exercise callbacks already dispatched when cleanup occurs.
        if (cancelledOnly || !entry.cancelled) entry.callback(performance.now())
      }
    },
  }
}
