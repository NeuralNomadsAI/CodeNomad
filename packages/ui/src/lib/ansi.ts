import { createAnsiSequenceParser, createColorPalette } from "ansi-sequence-parser"
import { HIGH_CONTRAST_TARGETS, strengthenContrast } from "./high-contrast"
import { contrastRatio, oklabLightness, withOklabLightness } from "./color-contrast"

export interface AnsiRenderOptions {
  highContrast?: boolean
  forcedColors?: boolean
  foreground?: string
  background?: string
}

const ESC_CHAR = "\u001b"
const ANSI_LITERAL_PATTERN = /\\u001b|\\x1b|\\033/
const ANSI_ESCAPE_PATTERN = /\u001b/

const colorPalette = createColorPalette()

export function hasAnsi(text: string): boolean {
  const normalized = normalizeAnsiText(text)
  return ANSI_ESCAPE_PATTERN.test(normalized)
}

export function ansiToHtml(text: string, options: AnsiRenderOptions = {}): string {
  const normalized = normalizeAnsiText(text)
  const parser = createAnsiSequenceParser()
  const tokens = parser.parse(normalized)
  return tokensToHtml(tokens, options)
}

export interface AnsiStreamRenderer {
  reset: () => void
  render: (chunk: string, options?: AnsiRenderOptions) => string
}

export function createAnsiStreamRenderer(): AnsiStreamRenderer {
  let parser = createAnsiSequenceParser()

  return {
    reset() {
      parser = createAnsiSequenceParser()
    },
    render(chunk: string, options: AnsiRenderOptions = {}) {
      const normalized = normalizeAnsiText(chunk)
      const tokens = parser.parse(normalized)
      return tokensToHtml(tokens, options)
    },
  }
}

function normalizeAnsiText(text: string): string {
  if (!ANSI_LITERAL_PATTERN.test(text)) {
    return text
  }

  return text
    .replace(/\\u001b/gi, ESC_CHAR)
    .replace(/\\x1b/gi, ESC_CHAR)
    .replace(/\\033/g, ESC_CHAR)
}

function tokensToHtml(tokens: { value: string; foreground: unknown; background: unknown; decorations: Set<string> }[], options: AnsiRenderOptions): string {
  let html = ""
  const colors = new Map<string, string>()

  for (const token of tokens) {
    if (!token.value) {
      continue
    }

    const styles = buildTokenStyles(token, options, colors)
    const escaped = escapeHtml(token.value)

    if (!styles) {
      html += escaped
      continue
    }

    html += `<span style="${styles}">${escaped}</span>`
  }

  return html
}

function buildTokenStyles(token: { foreground: any; background: any; decorations: Set<string> }, options: AnsiRenderOptions, colors: Map<string, string>): string | null {
  const decorations = token.decorations
  let foreground = token.foreground ? colorPalette.value(token.foreground) : null
  let background = token.background ? colorPalette.value(token.background) : null

  if (decorations.has("reverse")) {
    const swapped = foreground
    foreground = background
    background = swapped
  }

  if (options.highContrast && options.foreground && options.background) {
    // Dim keeps a lower contrast tier without fading its background or hidden text.
    const color = (foreground ?? options.foreground).toUpperCase()
    let surface = (background ?? options.background).toUpperCase()
    const regularTarget = HIGH_CONTRAST_TARGETS.text + 2.5
    if (background && Math.max(contrastRatio("#000000", surface), contrastRatio("#FFFFFF", surface)) < regularTarget) {
      const backgroundKey = `background:${surface}`
      const ink = contrastRatio("#000000", surface) > contrastRatio("#FFFFFF", surface) ? "#000000" : "#FFFFFF"
      background = colors.get(backgroundKey) ?? strengthenContrast(surface, [ink], regularTarget)
      colors.set(backgroundKey, background)
      surface = background
    }
    const dim = decorations.has("dim")
    const target = dim ? HIGH_CONTRAST_TARGETS.text : regularTarget
    const key = `${color}:${surface}:${target}`
    foreground = colors.get(key) ?? strengthenContrast(
      dim ? withOklabLightness(color, oklabLightness(surface)) : color, [surface], target)
    colors.set(key, foreground)
  }

  const styles: string[] = []

  if (foreground) {
    styles.push(`color: ${foreground}`)
  }

  if (background) {
    styles.push(`background-color: ${background}`)
  }

  if (decorations.has("bold")) {
    styles.push("font-weight: 600")
  }

  if (decorations.has("dim")) {
    if (options.forcedColors) styles.push("color: GrayText")
    else if (!options.highContrast) styles.push("opacity: 0.7")
  }

  if (decorations.has("italic")) {
    styles.push("font-style: italic")
  }

  const lines: string[] = []
  if (decorations.has("underline")) {
    lines.push("underline")
  }
  if (decorations.has("strikethrough")) {
    lines.push("line-through")
  }
  if (decorations.has("overline")) {
    lines.push("overline")
  }
  if (lines.length > 0) {
    styles.push(`text-decoration-line: ${lines.join(" ")}`)
  }

  if (decorations.has("hidden")) {
    styles.push("visibility: hidden")
    styles.push("color: transparent")
    styles.push("background-color: transparent")
  }

  return styles.length > 0 ? styles.join("; ") : null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
