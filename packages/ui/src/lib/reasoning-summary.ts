export function parseReasoningSummary(text: string): { title: string | null; body: string } {
  const content = text.trim()
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (!match) return { title: null, body: content }
  return { title: match[1]!.trim(), body: content.slice(match[0].length).trimEnd() }
}
