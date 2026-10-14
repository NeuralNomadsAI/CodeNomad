/**
 * A real difference the Monaco diff reader does not draw:
 * - "whitespace": only leading/trailing blanks differ, hidden by `ignoreTrimWhitespace`;
 * - "invisible": only line endings or a byte-order mark differ, never drawn in either mode.
 */
export type HiddenDiffChange = "whitespace" | "invisible"

// Mirrors Monaco's text model: one leading BOM is stripped and every line
// terminator splits lines; `ignoreTrimWhitespace` trims only spaces and tabs.
const LINE_BREAK = /\r\n|\r|\n/

function modelLines(text: string): string[] {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(LINE_BREAK)
}

const isBlank = (code: number) => code === 32 || code === 9

// Index scans like Monaco's first/lastNonWhitespaceIndex; edge regexes are quadratic on long blank runs.
function trimmedBounds(line: string): [number, number] {
  let start = 0, end = line.length
  while (start < end && isBlank(line.charCodeAt(start))) start++
  while (end > start && isBlank(line.charCodeAt(end - 1))) end--
  return [start, end]
}

function equalIgnoringEdgeBlanks(original: string, modified: string): boolean {
  const [originalStart, originalEnd] = trimmedBounds(original)
  const [modifiedStart, modifiedEnd] = trimmedBounds(modified)
  return originalEnd - originalStart === modifiedEnd - modifiedStart
    && original.slice(originalStart, originalEnd) === modified.slice(modifiedStart, modifiedEnd)
}

const isEmptyModel = (lines: string[]) => lines.length === 1 && lines[0] === ""

/** Classifies a difference Monaco would hide, or null when the reader draws a change. */
export function classifyHiddenDiffChange(before: string, after: string): HiddenDiffChange | null {
  if (before === after) return null
  const original = modelLines(before), modified = modelLines(after)
  // Monaco's legacy diff treats an empty side as a whole-file change, whitespace or not.
  if (isEmptyModel(original) || isEmptyModel(modified)) return isEmptyModel(original) && isEmptyModel(modified) ? "invisible" : null
  if (original.length !== modified.length) return null
  let whitespace = false
  for (let index = 0; index < original.length; index++) {
    if (original[index] === modified[index]) continue
    if (!equalIgnoringEdgeBlanks(original[index], modified[index])) return null
    whitespace = true
  }
  return whitespace ? "whitespace" : "invisible"
}
