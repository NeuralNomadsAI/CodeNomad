import type { Page } from "playwright"

/** Assert painted content in its owning surface, independently of CSS/mark mode. */
export async function waitForSearchHighlights(page: Page, selector: string, count: number, active = false): Promise<string[]> {
  const result = await page.waitForFunction(({ selector, count, active }) => {
    const roots = [...document.querySelectorAll(selector)]
    const ranges = CSS.highlights?.get(active ? "codenomad-search-active" : "codenomad-search")
    const texts = ranges
      ? [...ranges].filter(range => roots.some(root => root.contains(range.startContainer))).map(range => (range as Range).toString())
      : roots.flatMap(root => [...root.querySelectorAll(active ? "mark.session-search-match-active" : "mark.session-search-match")].map(mark => mark.textContent))
    return texts.length === count && texts
  }, { selector, count, active }, { timeout: 5000 })
  try { return await result.jsonValue() as string[] } finally { await result.dispose() }
}
