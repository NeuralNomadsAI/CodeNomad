export const DIFF_WHITESPACE_MODES = ["show", "hide"] as const
export type DiffWhitespaceMode = (typeof DIFF_WHITESPACE_MODES)[number]

// Mirrors Monaco's `ignoreTrimWhitespace` line equality: its text model splits
// on every line terminator and only spaces/tabs count as leading/trailing blanks.
const LINE_BREAK = /\r\n|\r|\n/
const EDGE_BLANKS = /^[ \t]+|[ \t]+$/g

function trimmedLines(text: string): string[] {
  return text.split(LINE_BREAK).map(line => line.replace(EDGE_BLANKS, ""))
}

/** True when the texts differ only by indentation, trailing blanks or line endings. */
export function isTrimWhitespaceOnlyChange(before: string, after: string): boolean {
  if (before === after) return false
  const original = trimmedLines(before), modified = trimmedLines(after)
  return original.length === modified.length && original.every((line, index) => line === modified[index])
}
