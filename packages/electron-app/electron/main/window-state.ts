import type { BrowserWindow } from "electron"
import type { ClientStateManager, NativeWindowState, WindowBounds } from "./client-state"

export const DEFAULT_WINDOW_WIDTH = 1400
export const DEFAULT_WINDOW_HEIGHT = 900

const MIN_WINDOW_WIDTH = 800
const MIN_WINDOW_HEIGHT = 600
const MIN_ZOOM_FACTOR = 0.25
const MAX_ZOOM_FACTOR = 5
const SAVE_DEBOUNCE_MS = 250

export interface DisplayWorkArea {
  x: number
  y: number
  width: number
  height: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function intersectionArea(bounds: WindowBounds, area: DisplayWorkArea): number {
  const width = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x))
  const height = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y))
  return width * height
}

function centerDistanceSquared(bounds: WindowBounds, area: DisplayWorkArea): number {
  const x = bounds.x + bounds.width / 2 - (area.x + area.width / 2)
  const y = bounds.y + bounds.height / 2 - (area.y + area.height / 2)
  return x * x + y * y
}

export function normalizeZoomFactor(value: unknown): number {
  if (!isFiniteNumber(value) || value <= 0) {
    return 1
  }
  return clamp(value, MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR)
}

export function normalizeNativeWindowState(value: unknown): NativeWindowState | undefined {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const candidate = value as Partial<NativeWindowState>
  const bounds = candidate.bounds
  if (
    !bounds ||
    !isFiniteNumber(bounds.x) ||
    !isFiniteNumber(bounds.y) ||
    !isFiniteNumber(bounds.width) ||
    !isFiniteNumber(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return undefined
  }

  return {
    bounds: {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    },
    maximized: candidate.maximized === true,
    fullscreen: candidate.fullscreen === true,
    zoomFactor: normalizeZoomFactor(candidate.zoomFactor),
  }
}

export function clampWindowBounds(bounds: WindowBounds, displays: DisplayWorkArea[]): WindowBounds | undefined {
  const normalized = normalizeNativeWindowState({ bounds, maximized: false, fullscreen: false, zoomFactor: 1 })?.bounds
  const usableDisplays = displays.filter(
    (area) =>
      isFiniteNumber(area.x) &&
      isFiniteNumber(area.y) &&
      isFiniteNumber(area.width) &&
      isFiniteNumber(area.height) &&
      area.width > 0 &&
      area.height > 0,
  )
  if (!normalized || usableDisplays.length === 0) {
    return undefined
  }

  const display = usableDisplays.reduce((best, area) => {
    const bestIntersection = intersectionArea(normalized, best)
    const areaIntersection = intersectionArea(normalized, area)
    if (areaIntersection !== bestIntersection) {
      return areaIntersection > bestIntersection ? area : best
    }
    return centerDistanceSquared(normalized, area) < centerDistanceSquared(normalized, best) ? area : best
  })

  const maximumWidth = Math.max(1, Math.floor(display.width))
  const maximumHeight = Math.max(1, Math.floor(display.height))
  const minimumWidth = Math.min(MIN_WINDOW_WIDTH, maximumWidth)
  const minimumHeight = Math.min(MIN_WINDOW_HEIGHT, maximumHeight)
  const width = clamp(normalized.width, minimumWidth, maximumWidth)
  const height = clamp(normalized.height, minimumHeight, maximumHeight)
  const x = clamp(normalized.x, display.x, display.x + maximumWidth - width)
  const y = clamp(normalized.y, display.y, display.y + maximumHeight - height)

  return { x, y, width, height }
}

export function restoreWindowState(window: BrowserWindow, state: NativeWindowState | undefined, bounds: WindowBounds | undefined) {
  if (!state) {
    return
  }

  if (bounds) {
    window.setBounds(bounds)
  }
  window.webContents.setZoomFactor(normalizeZoomFactor(state.zoomFactor))
  if (state.maximized) {
    window.maximize()
  }
  if (state.fullscreen) {
    window.setFullScreen(true)
  }
}

export class WindowStateTracker {
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private desiredZoomFactor: number

  constructor(
    private readonly window: BrowserWindow,
    private readonly clientState: ClientStateManager,
    initialState?: NativeWindowState,
  ) {
    this.desiredZoomFactor = normalizeZoomFactor(initialState?.zoomFactor)

    for (const event of ["move", "resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
      window.on(event as "move", () => this.scheduleSave())
    }
    const scheduleSave = () => this.scheduleSave()
    window.webContents.on("zoom-changed", scheduleSave)
    window.webContents.on("did-finish-load", () => {
      if (!window.webContents.isDestroyed()) {
        window.webContents.setZoomFactor(this.desiredZoomFactor)
      }
    })
    window.on("closed", () => this.clearTimer())
  }

  async flush(): Promise<void> {
    this.clearTimer()
    if (!this.window.isDestroyed()) {
      await this.captureAndQueue()
    }
    await this.clientState.flush()
  }

  private scheduleSave() {
    this.clearTimer()
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private clearTimer() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
  }

  private async saveNow() {
    try {
      await this.captureAndQueue()
    } catch (error) {
      console.warn("[client-state] failed to save window state", error)
    }
  }

  private captureAndQueue(): Promise<boolean> {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      return Promise.resolve(false)
    }

    this.desiredZoomFactor = normalizeZoomFactor(this.window.webContents.getZoomFactor())
    return this.clientState.saveWindowState({
      bounds: this.window.getNormalBounds(),
      maximized: this.window.isMaximized(),
      fullscreen: this.window.isFullScreen(),
      zoomFactor: this.desiredZoomFactor,
    })
  }
}
