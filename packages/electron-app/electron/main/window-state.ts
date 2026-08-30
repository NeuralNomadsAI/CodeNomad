import type { BrowserWindow } from "electron"
import type { ClientStateManager } from "./client-state"

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeWindowState {
  bounds: WindowBounds
  maximized: boolean
  fullscreen: boolean
  zoomFactor: number
}

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
  scaleFactor?: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function physicalBounds(bounds: WindowBounds, scaleFactor: number): WindowBounds {
  return {
    x: bounds.x * scaleFactor,
    y: bounds.y * scaleFactor,
    width: bounds.width * scaleFactor,
    height: bounds.height * scaleFactor,
  }
}

function intersectionArea(bounds: WindowBounds, area: DisplayWorkArea): number {
  const scaleFactor = isFiniteNumber(area.scaleFactor) && area.scaleFactor > 0 ? area.scaleFactor : 1
  bounds = physicalBounds(bounds, scaleFactor)
  area = physicalBounds(area, scaleFactor)
  const width = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x))
  const height = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y))
  return width * height
}

function centerDistanceSquared(bounds: WindowBounds, area: DisplayWorkArea): number {
  const scaleFactor = isFiniteNumber(area.scaleFactor) && area.scaleFactor > 0 ? area.scaleFactor : 1
  bounds = physicalBounds(bounds, scaleFactor)
  area = physicalBounds(area, scaleFactor)
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

  const scaleFactor = isFiniteNumber(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1
  const physical = physicalBounds(normalized, scaleFactor)
  const physicalDisplay = physicalBounds(display, scaleFactor)
  const maximumWidth = Math.max(1, Math.floor(physicalDisplay.width))
  const maximumHeight = Math.max(1, Math.floor(physicalDisplay.height))
  const minimumWidth = Math.min(MIN_WINDOW_WIDTH * scaleFactor, maximumWidth)
  const minimumHeight = Math.min(MIN_WINDOW_HEIGHT * scaleFactor, maximumHeight)
  const width = clamp(physical.width, minimumWidth, maximumWidth)
  const height = clamp(physical.height, minimumHeight, maximumHeight)
  const x = clamp(physical.x, physicalDisplay.x, physicalDisplay.x + maximumWidth - width)
  const y = clamp(physical.y, physicalDisplay.y, physicalDisplay.y + maximumHeight - height)

  return { x: x / scaleFactor, y: y / scaleFactor, width: width / scaleFactor, height: height / scaleFactor }
}

export function restoreWindowState(window: BrowserWindow, state: NativeWindowState | undefined, bounds: WindowBounds | undefined) {
  if (!state) {
    return
  }

  if (bounds) {
    window.setPosition(bounds.x, bounds.y)
    window.setContentSize(bounds.width, bounds.height)
  }
  window.webContents.setZoomFactor(normalizeZoomFactor(state.zoomFactor))
  if (state.maximized) {
    window.maximize()
  }
  if (state.fullscreen) {
    window.setFullScreen(true)
  }
}

export function installWindowZoomInput(window: BrowserWindow, setZoomLevel: (level: number) => void): void {
  const changeZoom = (delta: number) => setZoomLevel(window.webContents.getZoomLevel() + delta)
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || (!input.control && !input.meta) || input.alt) return
    if (input.key === "+" || input.key === "=") {
      event.preventDefault()
      changeZoom(0.5)
    } else if (input.key === "-") {
      event.preventDefault()
      changeZoom(-0.5)
    } else if (input.key === "0") {
      event.preventDefault()
      setZoomLevel(0)
    }
  })
  window.webContents.on("zoom-changed", (event, direction) => {
    event.preventDefault()
    changeZoom(direction === "in" ? 0.5 : -0.5)
  })
}

export class WindowStateTracker {
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private desiredZoomFactor: number
  private normalBounds: WindowBounds

  constructor(
    private readonly window: BrowserWindow,
    private readonly clientState: ClientStateManager,
    initialState?: NativeWindowState,
    private readonly windowId = clientState.activeWindowId,
  ) {
    this.desiredZoomFactor = normalizeZoomFactor(initialState?.zoomFactor)
    const [x, y] = typeof window.getPosition === "function" ? window.getPosition() : [0, 0]
    const [width, height] = typeof window.getContentSize === "function"
      ? window.getContentSize()
      : [DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT]
    this.normalBounds = initialState?.bounds ?? { x, y, width, height }

    for (const event of ["move", "resize"]) {
      window.on(event as "move", () => {
        if (!window.isMaximized() && !window.isFullScreen()) this.captureNormalBounds()
        this.scheduleSave()
      })
    }
    for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
      window.on(event as "maximize", () => this.scheduleSave())
    }
    window.webContents.on("zoom-changed", () => this.scheduleSave())
    window.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame && !window.webContents.isDestroyed()) {
        this.desiredZoomFactor = normalizeZoomFactor(window.webContents.getZoomFactor())
      }
    })
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

  setZoomLevel(level: number): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return
    this.window.webContents.setZoomLevel(level)
    this.desiredZoomFactor = normalizeZoomFactor(this.window.webContents.getZoomFactor())
    this.scheduleSave()
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
    if (!this.window.isMaximized() && !this.window.isFullScreen()) this.captureNormalBounds()
    return this.clientState.saveWindowState({
      bounds: this.normalBounds,
      maximized: this.window.isMaximized(),
      fullscreen: this.window.isFullScreen(),
      zoomFactor: this.desiredZoomFactor,
    }, this.windowId)
  }

  private captureNormalBounds(): void {
    const [x, y] = this.window.getPosition()
    const [width, height] = this.window.getContentSize()
    this.normalBounds = { x, y, width, height }
  }
}
