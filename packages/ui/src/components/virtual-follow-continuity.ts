const CONTINUITY_MIN_MS = 250
const CONTINUITY_STABLE_FRAMES = 8
const CONTINUITY_MAX_FRAMES = 90

interface MeasurementResetContinuityOptions {
  getScrollElement: () => HTMLDivElement | undefined
  getShellElement: () => HTMLDivElement | undefined
  getVirtualizerRoot: () => HTMLElement | null
  getSettlementMetrics: () => { maxOffset: number; atBottom: boolean } | null
  isActive: () => boolean
  isFollowing: () => boolean
}

export class MeasurementResetContinuity {
  private layer: HTMLDivElement | null = null
  private frame: number | null = null
  private startedAt = 0
  private stableFrames = 0
  private framesRemaining = 0
  private lastMaxOffset: number | null = null
  private previousRoot: HTMLElement | null = null

  constructor(private readonly options: MeasurementResetContinuityOptions) {}

  preserve() {
    const element = this.options.getScrollElement()
    const shell = this.options.getShellElement()
    if (!element || !shell || document.visibilityState !== "visible"
      || !this.options.isActive() || !this.options.isFollowing()) return

    this.clear()
    const elementRect = element.getBoundingClientRect()
    const shellRect = shell.getBoundingClientRect()
    if (elementRect.width <= 0 || elementRect.height <= 0) return
    const layer = element.cloneNode(true) as HTMLDivElement
    layer.classList.add("virtual-follow-list-continuity-layer")
    layer.removeAttribute("id")
    layer.removeAttribute("tabindex")
    layer.setAttribute("aria-hidden", "true")
    layer.setAttribute("inert", "")
    layer.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"))
    Object.assign(layer.style, {
      top: `${elementRect.top - shellRect.top}px`,
      left: `${elementRect.left - shellRect.left}px`,
      width: `${elementRect.width}px`,
      height: `${elementRect.height}px`,
    })
    shell.appendChild(layer)
    layer.scrollTop = element.scrollTop

    this.layer = layer
    this.startedAt = performance.now()
    this.stableFrames = 0
    this.framesRemaining = CONTINUITY_MAX_FRAMES
    this.lastMaxOffset = null
    this.previousRoot = this.options.getVirtualizerRoot()
    this.scheduleFrame()
  }

  clear() {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
    this.layer?.remove()
    this.layer = null
    this.stableFrames = 0
    this.framesRemaining = 0
    this.lastMaxOffset = null
    this.previousRoot = null
  }

  private scheduleFrame() {
    if (!this.layer || this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      const metrics = this.options.getSettlementMetrics()
      if (!metrics || !this.options.isActive() || !this.options.isFollowing()) {
        this.clear()
        return
      }

      const stable = this.lastMaxOffset !== null && Math.abs(metrics.maxOffset - this.lastMaxOffset) <= 0.5
      this.stableFrames = stable ? this.stableFrames + 1 : 0
      this.lastMaxOffset = metrics.maxOffset
      this.framesRemaining -= 1

      const replacementRoot = this.options.getVirtualizerRoot()
      const replacementReady = Boolean(replacementRoot && replacementRoot !== this.previousRoot)
      if (replacementReady
        && metrics.atBottom
        && performance.now() - this.startedAt >= CONTINUITY_MIN_MS
        && this.stableFrames >= CONTINUITY_STABLE_FRAMES) {
        this.clear()
        return
      }
      if (this.framesRemaining <= 0) {
        this.clear()
        return
      }
      this.scheduleFrame()
    })
  }
}
