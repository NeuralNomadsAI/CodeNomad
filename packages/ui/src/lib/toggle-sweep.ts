// Drag-to-toggle ("sweep"): pressing a toggle marked with data-toggle-sweep and dragging
// out of it flips it, and every toggle of the same group the pointer then crosses takes
// that same state, like layer eyes in image editors. Toggles change through their own
// click, so each keeps its handlers, disabled state and accessibility. Mouse and pen
// only: touch drags keep scrolling.

const ATTRIBUTE = "data-toggle-sweep"
// Distance between the points sampled along a drag, so fast drags skip no row.
const SAMPLE_STEP = 4

interface Sweep {
  pointerId: number
  group: string
  origin: HTMLElement
  on: boolean
  x: number
  y: number
  started: boolean
  visited: Set<HTMLElement>
}

let installed = false
let sweep: Sweep | null = null
let deferred: Array<() => void> = []

// A label stands for its control, so a row's whole label area sweeps.
function toggleFrom(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null
  const toggle = node.closest<HTMLElement>(`[${ATTRIBUTE}]`) ?? node.closest("label")?.control ?? null
  return toggle?.hasAttribute(ATTRIBUTE) ? toggle : null
}

function isOn(toggle: HTMLElement) {
  if (toggle instanceof HTMLInputElement) return toggle.checked
  return toggle.getAttribute("aria-pressed") === "true" || toggle.getAttribute("aria-checked") === "true"
}

function isDisabled(toggle: HTMLElement) {
  return (toggle as HTMLButtonElement).disabled === true || toggle.getAttribute("aria-disabled") === "true"
}

function setToggle(sweep: Sweep, toggle: HTMLElement) {
  if (sweep.visited.has(toggle)) return
  sweep.visited.add(toggle)
  if (toggle.isConnected && !isDisabled(toggle) && isOn(toggle) !== sweep.on) toggle.click()
}

function install() {
  const prevent = (event: Event) => { if (sweep) event.preventDefault() }

  const stop = () => {
    sweep = null
    window.removeEventListener("pointermove", move, true)
    window.removeEventListener("pointerup", end, true)
    window.removeEventListener("pointercancel", end, true)
    const runs = deferred
    deferred = []
    for (const run of runs) run()
  }

  const move = (event: PointerEvent) => {
    if (!sweep || event.pointerId !== sweep.pointerId) return
    // A release lost to another window or a system prompt ends the sweep here.
    if ((event.buttons & 1) === 0) return stop()
    const current = sweep
    const dx = event.clientX - current.x, dy = event.clientY - current.y
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / SAMPLE_STEP))
    for (let step = 1; step <= steps; step += 1) {
      const toggle = toggleFrom(document.elementFromPoint(current.x + dx * step / steps, current.y + dy * step / steps))
      if (!current.started) {
        if (toggle === current.origin) continue
        current.started = true
        window.getSelection()?.removeAllRanges()
        setToggle(current, current.origin)
      }
      if (toggle && toggle.getAttribute(ATTRIBUTE) === current.group) setToggle(current, toggle)
    }
    current.x = event.clientX
    current.y = event.clientY
  }

  // The release after a sweep would click whatever lies under it, the origin included.
  const swallowClick = (event: MouseEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    window.removeEventListener("click", swallowClick, true)
  }

  const end = (event: PointerEvent) => {
    if (!sweep || event.pointerId !== sweep.pointerId) return
    if (sweep.started && event.type === "pointerup") {
      window.addEventListener("click", swallowClick, true)
      setTimeout(() => window.removeEventListener("click", swallowClick, true))
    }
    stop()
  }

  window.addEventListener("pointerdown", (event) => {
    if (sweep) {
      // Another pointer (a touch during a mouse drag) leaves the sweep alone; the same
      // pointer pressing again lost its release.
      if (event.pointerId !== sweep.pointerId) return
      stop()
    }
    if (event.button !== 0 || event.pointerType === "touch") return
    const origin = toggleFrom(event.target)
    if (!origin || isDisabled(origin)) return
    sweep = {
      pointerId: event.pointerId,
      group: origin.getAttribute(ATTRIBUTE) ?? "",
      origin,
      on: !isOn(origin),
      x: event.clientX,
      y: event.clientY,
      started: false,
      visited: new Set(),
    }
    window.addEventListener("pointermove", move, true)
    window.addEventListener("pointerup", end, true)
    window.addEventListener("pointercancel", end, true)
  }, true)
  // A sweep neither selects text nor drags the row it starts in.
  document.addEventListener("selectstart", prevent, true)
  document.addEventListener("dragstart", prevent, true)
}

// Runs `run` when the sweep in progress ends, at once otherwise: a toggle whose change is
// costly to apply (re-rendering the transcript) applies a whole sweep once, on release.
export function afterSweep(run: () => void) {
  if (sweep?.started) deferred.push(run)
  else run()
}

// Returns the group for a toggle's data-toggle-sweep attribute: independent toggles of one
// kind (a column of eyes, a list of selection checkboxes) share a group. Exclusive
// selectors (tabs, presets, radio-like choices) never take one.
export function toggleSweepGroup(group: string) {
  if (!installed && typeof window !== "undefined") {
    installed = true
    install()
  }
  return group
}
