# Bracket Math Delimiters Design

## Goal

Support inline `\(...\)` and display `\[...\]` math in CodeNomad Markdown while preserving existing `$...$` and `$$...$$` behavior. No unrelated Markdown changes.

## Approach

Keep `marked-katex-extension` as owner of dollar-delimited math. Add two small parser-native Marked extensions in `packages/ui/src/lib/markdown.ts`:

- Inline rule: recognize `\(...\)` and render with KaTeX `displayMode: false`.
- Block rule: recognize `\[...\]` and render with KaTeX `displayMode: true`.

Both rules will use `katex.renderToString()` with the same error policy as the existing integration: `throwOnError: false` and `strict: "ignore"`. Parser-native rules avoid source rewriting, ignore fenced/code content through Marked's normal lexer flow, and preserve unmatched delimiters as plain Markdown text.

## Integration

Register the two rules beside the existing `markedKatex(...)` registration in `setupRenderer()`. Existing renderer setup, syntax highlighting, HTML handling, styles, and component APIs remain unchanged. No new runtime dependency is needed because KaTeX is already a direct UI dependency.

## Edge Cases

- `\\(` and `\\[` remain escaped literal text rather than opening math.
- Inline math must close with `\)` before a line break.
- Display math may span lines and must close with `\]`.
- Empty or unmatched delimiter pairs remain text.
- Existing dollar delimiter boundary behavior remains controlled by `marked-katex-extension` with `nonStandard: true`.

## Tests

Add focused Markdown rendering regression tests covering:

- `\(x^2\)` renders inline KaTeX.
- `\[x^2\]` renders display KaTeX, including multiline content.
- `$x^2$` and `$$x^2$$` still render.
- Delimiters inside inline and fenced code remain literal.
- Escaped, empty, and unmatched bracket delimiters remain literal.

Run the repository's confirmed UI test command, UI typecheck, and inspect the final diff.
