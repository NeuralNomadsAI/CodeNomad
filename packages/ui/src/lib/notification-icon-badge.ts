import iconUrl from "../images/CodeNomad-Icon.png"
import { getUnreadToastCount, subscribeToastHistory } from "./notifications"
import { setNativeNotificationBadge } from "./native/notification-badge"

/** Follow the bell's in-memory history, not session status or OS notifications. */
export function startNotificationIconBadge(): () => void {
  const originals = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')]
  const snapshots = originals.map(link => ({ link, href: link.getAttribute("href"), type: link.getAttribute("type") }))
  const links = originals.length ? originals : [document.createElement("link")]
  if (!originals.length) {
    links[0].rel = "icon"
    links[0].href = iconUrl
    document.head.append(links[0])
  }

  let stopped = false
  let count = -1
  const image = new Image()
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 32
  const context = canvas.getContext("2d")

  function restore() {
    for (const { link, href, type } of snapshots) {
      if (href === null) link.removeAttribute("href")
      else link.setAttribute("href", href)
      if (type === null) link.removeAttribute("type")
      else link.setAttribute("type", type)
    }
  }

  function paint() {
    if (stopped || !context || !image.naturalWidth) return
    if (count === 0 && originals.length) {
      restore()
      return
    }
    context.clearRect(0, 0, 32, 32)
    context.drawImage(image, 0, 0, 32, 32)
    if (count > 0) {
      // A dot stays legible at tab-icon sizes; the bell retains the exact count.
      context.beginPath()
      context.arc(25, 7, 6, 0, Math.PI * 2)
      context.fillStyle = "#dc2626"
      context.fill()
      context.lineWidth = 2
      context.strokeStyle = "#ffffff"
      context.stroke()
    }
    const href = canvas.toDataURL("image/png")
    for (const link of links) {
      link.type = "image/png"
      link.href = href
    }
  }

  const update = () => {
    const next = getUnreadToastCount()
    if (stopped || next === count) return
    count = next
    paint()
    void setNativeNotificationBadge(count).catch(error => {
      console.warn("[notifications] native icon badge unavailable", error)
    })
  }
  image.onload = paint
  image.src = iconUrl
  const unsubscribe = subscribeToastHistory(update)

  return () => {
    if (stopped) return
    stopped = true
    unsubscribe()
    image.onload = null
    restore()
    if (!originals.length) links[0].remove()
    void setNativeNotificationBadge(0).catch(() => {})
  }
}
