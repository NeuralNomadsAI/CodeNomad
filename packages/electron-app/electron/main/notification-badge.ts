import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { validateMainFrame } from "./ipc-security"

// Windows nativeImage bitmaps are BGRA. No renderer-supplied image is accepted.
export function notificationBadgeBitmap(count: number): Buffer {
  const pixels = Buffer.alloc(32 * 32 * 4)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const offset = (y * 32 + x) * 4
    const alpha = Math.round(Math.max(0, Math.min(1, 16 - Math.hypot(x - 15.5, y - 15.5))) * 255)
    pixels.set([Math.round(48 * alpha / 255), Math.round(48 * alpha / 255), Math.round(220 * alpha / 255), alpha], offset)
  }
  const font = [0b111101101101111, 0b010110010010111, 0b111001111100111,
    0b111001111001111, 0b101101111001001, 0b111100111001111,
    0b111100111101111, 0b111001001001001, 0b111101111101111,
    0b111101111001111, 0b000010111010000]
  const text = count > 99 ? "99+" : String(count)
  const scale = text.length > 2 ? 2 : 3
  const left = Math.floor((32 - (text.length * 4 - 1) * scale) / 2)
  const top = Math.floor((32 - 5 * scale) / 2)
  for (let i = 0; i < text.length; i++) {
    const glyph = font[text[i] === "+" ? 10 : Number(text[i])]!
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
      if (!(glyph & (1 << (14 - y * 3 - x)))) continue
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        pixels.fill(255, ((top + y * scale + dy) * 32 + left + i * 4 * scale + x * scale + dx) * 4,
          ((top + y * scale + dy) * 32 + left + i * 4 * scale + x * scale + dx) * 4 + 4)
      }
    }
  }
  return pixels
}

export function setupNotificationBadgeIPC(
  ipc: Pick<IpcMain, "handle">,
  resolve: (sender: IpcMainInvokeEvent["sender"]) => BrowserWindow | undefined,
  allowedOrigins: (window: BrowserWindow) => string[],
  render: (count: number, windows: BrowserWindow[]) => void,
): (window: BrowserWindow) => void {
  const counts = new Map<BrowserWindow, number>()
  const navigating = new Set<BrowserWindow>()
  const publish = () => render([...counts.values()].reduce((sum, count) => sum + count, 0),
    [...counts.keys()].filter(window => !window.isDestroyed()))
  const bind = (window: BrowserWindow) => {
    if (counts.has(window)) return
    counts.set(window, 0)
    const clear = () => { if (!counts.has(window)) return; counts.set(window, 0); publish() }
    window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (!counts.has(window) || !mainFrame || inPlace) return
      navigating.add(window)
      clear()
    })
    // Accept bootstrap calls from the newly committed document, not just calls
    // after did-finish-load (which can be later than history restoration).
    window.webContents.on("did-navigate", () => navigating.delete(window))
    window.webContents.on("render-process-gone", () => {
      if (!counts.has(window)) return
      navigating.add(window)
      clear()
    })
    window.on("closed", () => { counts.delete(window); navigating.delete(window); publish() })
    publish()
  }
  ipc.handle("notifications:setBadge", (event, count: unknown) => {
    const window = resolve(event.sender)
    if (!window || !counts.has(window)) throw new Error("Notification badges require an owned main window")
    validateMainFrame(event, window, allowedOrigins(window))
    if (navigating.has(window)) throw new Error("Notification badge renderer is navigating")
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 50) {
      throw new Error("Notification badge count must be an integer from 0 to 50")
    }
    counts.set(window, count)
    publish()
  })
  return bind
}
