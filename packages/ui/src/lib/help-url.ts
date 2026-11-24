export const HELP_BASE_URL = "https://neuralnomadsai.github.io/CodeNomad/"

const locales = new Set(["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr"])

export type HelpDestination = { page: string; anchor?: string }

/** Localized help page and optional section; malformed paths fall back to its home. */
export function helpUrl(locale?: string, page?: string, anchor?: string): string {
  const tag = typeof locale === "string" ? locale.trim() : ""
  const base = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(tag) ? tag.toLowerCase().replace(/_/g, "-").split("-")[0] : undefined
  const language = base === "zh" ? "zh-Hans" : base === "iw" ? "he" : base && locales.has(base) ? base : "en"
  const article = typeof page === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page) ? `${page}.html` : ""
  const section = article && typeof anchor === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(anchor) ? `#${anchor}` : ""
  return `${HELP_BASE_URL}${language}/${article}${section}`
}
