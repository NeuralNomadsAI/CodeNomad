export const HELP_BASE_URL = "https://neuralnomadsai.github.io/CodeNomad/"

const locales = new Set(["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr"])

export function helpUrl(locale?: string): string {
  const tag = typeof locale === "string" ? locale.trim() : ""
  const base = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(tag) ? tag.toLowerCase().replace(/_/g, "-").split("-")[0] : undefined
  const language = base === "zh" ? "zh-Hans" : base === "iw" ? "he" : base && locales.has(base) ? base : "en"
  return `${HELP_BASE_URL}${language}/`
}
