export function getPastedTextLineCount(text: string): number {
  if (!text) return 0
  return text.split("\n").length
}
