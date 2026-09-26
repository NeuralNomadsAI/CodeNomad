import { createEffect, onCleanup, type Accessor } from "solid-js"
import { useTheme } from "../theme"

/** Monaco accepts concrete hex colors, rather than CSS variables. Resolve the
 * shared palette after its DOM update, including custom and Auto palettes. */
export function useMonacoTheme(api: Accessor<any>) {
  const { isDark, colorScheme } = useTheme()
  createEffect(() => {
    const monaco = api()
    if (!monaco) return
    isDark()
    colorScheme()
    const root = document.documentElement
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d")!
    const probe = document.createElement("span")
    probe.hidden = true
    root.append(probe)
    const color = (token: string, alpha?: string) => {
      probe.style.color = `var(${token})`
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = getComputedStyle(probe).color
      context.fillRect(0, 0, 1, 1)
      const bytes = context.getImageData(0, 0, 1, 1).data
      return `#${Array.from(bytes.slice(0, 3), n => n.toString(16).padStart(2, "0")).join("")}${alpha ?? ""}`
    }
    const update = () => {
      monaco.editor.defineTheme("codenomad", {
        base: isDark() ? "vs-dark" : "vs", inherit: false,
        rules: [
          { token: "", foreground: color("--text-primary").slice(1) },
          { token: "comment", foreground: color("--text-muted").slice(1) },
          { token: "keyword", foreground: color("--accent-primary").slice(1) },
          { token: "string", foreground: color("--status-success").slice(1) },
          { token: "number", foreground: color("--status-warning").slice(1) },
          { token: "type", foreground: color("--accent-primary").slice(1) },
          { token: "tag", foreground: color("--accent-primary").slice(1) },
          { token: "attribute.name", foreground: color("--status-warning").slice(1) },
          { token: "delimiter", foreground: color("--text-muted").slice(1) },
        ],
        colors: {
          "editor.background": color("--surface-base"), "editor.foreground": color("--text-primary"),
          "editorGutter.background": color("--surface-base"),
          "editorLineNumber.foreground": color("--text-muted"), "editorLineNumber.activeForeground": color("--text-primary"),
          "editor.selectionBackground": color("--accent-primary", "30"),
          "editor.lineHighlightBackground": color("--accent-primary", "0a"),
          "editorWidget.background": color("--surface-secondary"), "editorWidget.border": color("--border-base"),
          "editorBracketHighlight.foreground1": color("--text-primary"),
          "editorBracketHighlight.foreground2": color("--accent-primary"),
          "editorBracketHighlight.foreground3": color("--status-success"),
          "editorBracketHighlight.foreground4": color("--text-primary"),
          "editorBracketHighlight.foreground5": color("--accent-primary"),
          "editorBracketHighlight.foreground6": color("--status-success"),
          "diffEditor.insertedLineBackground": color("--status-success", "14"),
          "diffEditor.removedLineBackground": color("--status-error", "14"),
          "diffEditor.insertedTextBackground": color("--status-success", "2b"),
          "diffEditor.removedTextBackground": color("--status-error", "2b"),
          "diffEditorGutter.insertedLineBackground": color("--status-success", "24"),
          "diffEditorGutter.removedLineBackground": color("--status-error", "24"),
          "diffEditor.diagonalFill": color("--text-muted", "24"),
          "diffEditor.unchangedRegionBackground": color("--surface-secondary"),
          "diffEditor.unchangedRegionForeground": color("--text-muted"),
        },
      })
      monaco.editor.setTheme("codenomad")
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ["style", "class", "data-color-scheme"] })
    onCleanup(() => { observer.disconnect(); probe.remove() })
  })
}
