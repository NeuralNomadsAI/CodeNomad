import assert from "node:assert/strict"
import { test } from "node:test"
import { monacoTheme } from "./theme"
import { contrastRatio, mix } from "../color-contrast"

const tokens: Record<string, string> = {
  "--text-primary": "#eeeeee", "--text-muted": "#bbbbbb", "--accent-primary": "#6688ff", "--accent-text": "#aaccff",
  "--surface-canvas": "#202020", "--surface-overlay": "#303030", "--surface-secondary": "#404040",
  "--status-success": "#88ffbb", "--status-error": "#ffbbbb", "--status-warning": "#ffffaa",
  "--selection-highlight-bg": "#242424", "--selection-highlight-strong-bg": "#282828", "--selection-highlight-text": "#eeeeee",
}
const resolve = (token: string) => tokens[token] ?? "#aaaaaa"
const alpha = (color: string) => parseInt(color.slice(7), 16)

test("Monaco strengthens selection and ordered line/gutter/word tints, keeping secondary numbers", () => {
  for (const dark of [false, true]) {
    const normal = monacoTheme(resolve, { dark, highContrast: false, forcedColors: false })
    const strong = monacoTheme(resolve, { dark, highContrast: true, forcedColors: false })
    assert.equal(normal.rules.find(rule => rule.token === "keyword")!.foreground, tokens["--accent-primary"].slice(1))
    assert.equal(strong.base, dark ? "vs-dark" : "vs")
    assert.equal(strong.colors["editorLineNumber.foreground"], "#bbbbbb")
    assert.equal(strong.colors["editorLineNumber.activeForeground"], "#eeeeee")
    assert.equal(strong.colors["editor.selectionBackground"], tokens["--selection-highlight-strong-bg"])
    assert.equal(strong.colors["editor.selectionForeground"], tokens["--selection-highlight-text"])
    assert.notEqual(strong.colors["editor.selectionBackground"], strong.colors["editor.inactiveSelectionBackground"])
    assert.ok(contrastRatio(strong.colors["editor.selectionForeground"]!.toUpperCase(), strong.colors["editor.selectionBackground"].toUpperCase()) >= 7.5)
    for (const { foreground } of strong.rules) {
      assert.ok(contrastRatio(`#${foreground.toUpperCase()}`, strong.colors["editor.lineHighlightBackground"].toUpperCase()) >= 7.5)
    }
    for (const token of ["keyword", "type", "tag"]) {
      assert.equal(strong.rules.find(rule => rule.token === token)!.foreground, tokens["--accent-text"].slice(1))
    }
    assert.equal(strong.colors["editorBracketHighlight.foreground2"], tokens["--accent-text"])
    for (const kind of ["inserted", "removed"]) {
      const line = `diffEditor.${kind}LineBackground` as keyof typeof strong.colors
      const gutter = `diffEditorGutter.${kind}LineBackground` as keyof typeof strong.colors
      const word = `diffEditor.${kind}TextBackground` as keyof typeof strong.colors
      assert.ok(alpha(strong.colors[line]!) < alpha(strong.colors[gutter]!))
      assert.ok(alpha(strong.colors[gutter]!) < alpha(strong.colors[word]!))
      const composite = (paint: string, base: string) => mix(paint.slice(0, 7).toUpperCase(), base, alpha(paint) / 255)
      const lineBackground = composite(strong.colors[line]!, tokens["--surface-canvas"].toUpperCase())
      const wordBackground = composite(strong.colors[word]!, lineBackground)
      for (const { foreground } of strong.rules) {
        assert.ok(contrastRatio(`#${foreground.toUpperCase()}`, wordBackground) >= 7.5, `${kind}: ${foreground} on ${wordBackground}`)
      }
    }
    assert.ok(!Object.keys(strong.colors).some(key => /focus/i.test(key)))
  }
})

test("Monaco resolves forced-colour surfaces, text and selection by their distinct roles", () => {
  const system = { background: "#ffffff", foreground: "#000000", selection: "#000080", selectionText: "#ffff00" }
  const theme = monacoTheme((_token, role = "foreground") => system[role], { dark: false, highContrast: false, forcedColors: true })
  assert.equal(theme.colors["editor.background"], system.background)
  assert.equal(theme.colors["editorGutter.background"], system.background)
  assert.equal(theme.colors["editorWidget.background"], system.background)
  assert.equal(theme.colors["editor.foreground"], system.foreground)
  assert.equal(theme.rules[0].foreground, "000000")
  assert.equal(theme.colors["editor.selectionBackground"], system.selection)
  assert.equal(theme.colors["editor.selectionForeground"], system.selectionText)
})
