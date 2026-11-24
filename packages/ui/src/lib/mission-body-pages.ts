/** Whether a body's loaded prefix `text` (of `characters` in all) shows reader page
 * `page` exactly as the whole text would: `missionMarkdownPage` reads through the page
 * end and the rest of its final line, so either the body is whole or a line break
 * follows the page end. */
export function missionBodyCovers(text: string, characters: number, page: number, pageSize: number): boolean {
  return text.length >= characters || text.indexOf("\n", (page + 1) * pageSize) >= 0
}

/** The prefix length to read for that page: what is loaded once it covers the page,
 * else through the page end, then one more slice at a time until a line break. */
export function missionBodyNeed(body: { text: string; characters: number } | undefined, page: number, pageSize: number): number {
  const end = (page + 1) * pageSize
  if (!body) return end + 1
  if (missionBodyCovers(body.text, body.characters, page, pageSize)) return Math.min(body.text.length, body.characters)
  return Math.max(end + 1, body.text.length + 1)
}
