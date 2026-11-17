import { createEffect, onCleanup, type Accessor } from "solid-js"
import { useTheme } from "../theme"
import { createCssColorResolver } from "../css-color"
import { contrastRatio, mix } from "../color-contrast"
import { HIGH_CONTRAST_TARGETS } from "../high-contrast"

export function monacoTheme(
  resolve: ReturnType<typeof createCssColorResolver>["resolve"],
  options: { dark: boolean; highContrast: boolean; forcedColors: boolean },
) {
  const stronger = options.highContrast || options.forcedColors
  const accent = options.highContrast ? "--accent-text" : "--accent-primary"
  const color = (token: string, alpha?: string, role: "background" | "foreground" | "selection" | "selectionText" = "foreground") =>
    `${resolve(token, role)}${alpha ?? ""}`
  const background = resolve("--surface-canvas", "background").toUpperCase()
  const foregrounds = ["--text-primary", "--text-muted", accent, "--status-success", "--status-warning", "--status-error"].map(token => {
    const foreground = resolve(token, "foreground").toUpperCase()
    return { foreground, target: Math.min(HIGH_CONTRAST_TARGETS.text, contrastRatio(foreground, background)) }
  })
  const diffAlphas = (token: string) => {
    if (!stronger) return ["14", "24", "2b"]
    const tint = resolve(token, "foreground").toUpperCase()
    const at = (scale: number) => [0x28, 0x40, 0x55].map(alpha => Math.floor(alpha * scale / 255))
    const passes = (scale: number) => {
      const [line, gutter, text] = at(scale)
      const lineBackground = mix(tint, background, line / 255)
      // Word paint overlays line paint; secondary gutters share the same budget.
      const backgrounds = [lineBackground, mix(tint, background, gutter / 255), mix(tint, lineBackground, text / 255)]
      return foregrounds.every(({ foreground, target }) => backgrounds.every(bg => contrastRatio(foreground, bg) >= target))
    }
    let low = 0, high = 255
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (passes(middle)) low = middle
      else high = middle - 1
    }
    return at(low).map(alpha => alpha.toString(16).padStart(2, "0"))
  }
  const inserted = diffAlphas("--status-success"), removed = diffAlphas("--status-error")
  return {
    base: options.dark ? "vs-dark" as const : "vs" as const, inherit: false,
    rules: [
      { token: "", foreground: color("--text-primary").slice(1) },
      { token: "comment", foreground: color("--text-muted").slice(1) },
      { token: "keyword", foreground: color(accent).slice(1) },
      { token: "string", foreground: color("--status-success").slice(1) },
      { token: "number", foreground: color("--status-warning").slice(1) },
      { token: "type", foreground: color(accent).slice(1) },
      { token: "tag", foreground: color(accent).slice(1) },
      { token: "attribute.name", foreground: color("--status-warning").slice(1) },
      { token: "delimiter", foreground: color("--text-muted").slice(1) },
    ],
    colors: {
      "editor.background": color("--surface-canvas", undefined, "background"), "editor.foreground": color("--text-primary"),
      "editorGutter.background": color("--surface-canvas", undefined, "background"),
      "editorLineNumber.foreground": color("--text-muted"), "editorLineNumber.activeForeground": color("--text-primary"),
      "editor.selectionBackground": stronger ? color("--selection-highlight-strong-bg", undefined, "selection") : color("--accent-primary", "30", "selection"),
      ...(stronger ? { "editor.selectionForeground": color("--selection-highlight-text", undefined, "selectionText") } : {}),
      "editor.inactiveSelectionBackground": stronger ? color("--selection-highlight-bg", undefined, "selection") : color("--accent-primary", "20", "selection"),
      "editor.lineHighlightBackground": stronger ? color("--selection-highlight-bg", undefined, "background") : color("--accent-primary", "0a"),
      "editorWidget.background": color("--surface-overlay", undefined, "background"), "editorWidget.border": color("--border-base"),
      "editorBracketHighlight.foreground1": color("--text-primary"),
      "editorBracketHighlight.foreground2": color(accent),
      "editorBracketHighlight.foreground3": color("--status-success"),
      "editorBracketHighlight.foreground4": color("--text-primary"),
      "editorBracketHighlight.foreground5": color(accent),
      "editorBracketHighlight.foreground6": color("--status-success"),
      "diffEditor.insertedLineBackground": color("--status-success", inserted[0]),
      "diffEditor.removedLineBackground": color("--status-error", removed[0]),
      "diffEditor.insertedTextBackground": color("--status-success", inserted[2]),
      "diffEditor.removedTextBackground": color("--status-error", removed[2]),
      "diffEditorGutter.insertedLineBackground": color("--status-success", inserted[1]),
      "diffEditorGutter.removedLineBackground": color("--status-error", removed[1]),
      "diffEditor.diagonalFill": color("--text-muted", "24"),
      "diffEditor.unchangedRegionBackground": color("--surface-secondary", undefined, "background"),
      "diffEditor.unchangedRegionForeground": color("--text-muted"),
    },
  }
}

/** Resolve after the shared palette update, including media-only transitions. */
export function useMonacoTheme(api: Accessor<any>) {
  const { isDark, themeRevision, highContrast, forcedColors } = useTheme()
  createEffect(() => {
    const monaco = api()
    if (!monaco) return
    themeRevision()
    const resolver = createCssColorResolver()
    monaco.editor.defineTheme("codenomad", monacoTheme(resolver.resolve, {
      dark: isDark(), highContrast: highContrast(), forcedColors: forcedColors(),
    }))
    monaco.editor.setTheme("codenomad")
    onCleanup(resolver.dispose)
  })
}
