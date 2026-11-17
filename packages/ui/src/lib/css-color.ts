export type CssColorRole = "background" | "foreground" | "selection" | "selectionText"
const systemColors: Record<CssColorRole, string> = {
  background: "Canvas", foreground: "CanvasText", selection: "Highlight", selectionText: "HighlightText",
}

/** Resolves colour tokens, including derived color-mix() roles, to concrete
 * #rrggbb values for consumers that do not accept CSS colours (Monaco, MUI,
 * extension frames). Call dispose() to remove the probe element. */
export function createCssColorResolver(root: HTMLElement = document.documentElement) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const context = canvas.getContext("2d")!
  const probe = document.createElement("span")
  probe.hidden = true
  // Only the measuring probe opts out: its requested system role must survive
  // the browser's automatic foreground substitution.
  probe.style.forcedColorAdjust = "none"
  root.append(probe)
  return {
    resolve(token: string, role: CssColorRole = "foreground") {
      probe.style.color = window.matchMedia?.("(forced-colors: active)").matches
        ? systemColors[role] : `var(${token})`
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = getComputedStyle(probe).color
      context.fillRect(0, 0, 1, 1)
      const bytes = context.getImageData(0, 0, 1, 1).data
      return `#${Array.from(bytes.slice(0, 3), n => n.toString(16).padStart(2, "0")).join("")}`
    },
    dispose: () => probe.remove(),
  }
}

/** One-shot resolution of a single token. */
export function resolveCssColor(token: string, role: CssColorRole = "foreground") {
  const resolver = createCssColorResolver()
  try { return resolver.resolve(token, role) } finally { resolver.dispose() }
}
