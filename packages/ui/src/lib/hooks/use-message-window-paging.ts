import { createEffect, onCleanup, type Accessor } from "solid-js"
import type { VirtualFollowListApi, VirtualFollowScrollSnapshot } from "../../components/virtual-follow-list"
import type { InstanceMessageStore } from "../../stores/message-v2/instance-store"
import { loadNewerMessages, loadOlderMessages } from "../../stores/session-api"

export function useMessageWindowPaging(options: {
  instanceId: Accessor<string>
  sessionId: Accessor<string>
  isActive: Accessor<boolean>
  store: Accessor<InstanceMessageStore>
  api: Accessor<VirtualFollowListApi | null>
  element: Accessor<HTMLDivElement | undefined>
}): void {
  let loading = false

  const load = (direction: "older" | "newer") => {
    if (loading || !options.isActive()) return
    const window = options.store().getMessageWindow(options.sessionId())
    if (!window || (direction === "older" ? !window.olderCursor : window.cursor === undefined)) return

    const instanceId = options.instanceId()
    const sessionId = options.sessionId()
    if (options.store().hasPendingSends(sessionId)) return
    const api = options.api()
    const followSnapshot = api?.captureScrollSnapshot()
    loading = true
    const request = direction === "older" ? loadOlderMessages(instanceId, sessionId) : loadNewerMessages(instanceId, sessionId)
    void request.then((committed) => {
      if (!committed || !options.isActive() || options.instanceId() !== instanceId || options.sessionId() !== sessionId) {
        loading = false
        return
      }
      if (!api || !followSnapshot) {
        loading = false
        return
      }
      const snapshot: VirtualFollowScrollSnapshot = direction === "older"
        ? { scrollTop: Number.MAX_SAFE_INTEGER, atBottom: true, followModeType: followSnapshot.followModeType }
        : { scrollTop: 0, atBottom: false, followModeType: followSnapshot.followModeType }
      api.restoreScrollSnapshot(snapshot, {
        behavior: "auto",
        onApplied: () => { loading = false },
        onCancelled: () => { loading = false },
        fallback: () => { loading = false },
      })
    }).catch(() => { loading = false })
  }

  createEffect(() => {
    const element = options.element()
    void options.sessionId()
    if (!element || !options.isActive()) return
    loading = false
    let previousTop = element.scrollTop
    let lastTouchY: number | null = null
    const atTop = () => element.scrollTop <= 1
    const atBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight <= 1
    const handleScroll = () => {
      const nextTop = element.scrollTop
      if (nextTop < previousTop && atTop()) load("older")
      else if (nextTop > previousTop && atBottom()) load("newer")
      previousTop = nextTop
    }
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && atTop()) load("older")
      else if (event.deltaY > 0 && atBottom()) load("newer")
    }
    const handleTouchStart = (event: TouchEvent) => { lastTouchY = event.touches[0]?.clientY ?? null }
    const handleTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null
      if (nextY !== null && lastTouchY !== null) {
        if (nextY > lastTouchY && atTop()) load("older")
        else if (nextY < lastTouchY && atBottom()) load("newer")
      }
      lastTouchY = nextY
    }
    const handleTouchEnd = () => { lastTouchY = null }
    element.addEventListener("scroll", handleScroll, { passive: true })
    element.addEventListener("wheel", handleWheel, { passive: true })
    element.addEventListener("touchstart", handleTouchStart, { passive: true })
    element.addEventListener("touchmove", handleTouchMove, { passive: true })
    element.addEventListener("touchend", handleTouchEnd, { passive: true })
    onCleanup(() => {
      element.removeEventListener("scroll", handleScroll)
      element.removeEventListener("wheel", handleWheel)
      element.removeEventListener("touchstart", handleTouchStart)
      element.removeEventListener("touchmove", handleTouchMove)
      element.removeEventListener("touchend", handleTouchEnd)
      loading = false
    })
  })
}
