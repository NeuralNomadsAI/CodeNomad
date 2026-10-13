import assert from "node:assert/strict"
import { test } from "node:test"

test("reader and shared truncation dependencies exist in every dictionary with matching placeholders", async () => {
  const locales = ["en", "fr", "es", "de", "ru", "ja", "zh-Hans", "he", "ne", "tr"]
  const keys = ["toolCall.output.truncated", "toolCall.permission.diff.page", "markdown.copy", "markdown.codeBlock.copy.copied", "markdown.codeBlock.copy.failed",
    "missions.control.history.title", "missions.control.history.before", "missions.control.history.after", "missions.control.objective", "missions.control.notes", "missions.control.brief", "missions.control.summary", "missions.control.report.evidence", "missions.control.report.next", "missions.control.artifact", "missions.control.reader.close"]
  let english: Record<string, string> = {}
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const locale of locales) {
    const module = await import(`../lib/i18n/messages/${locale}/index.ts`)
    const messages = Object.values(module)[0] as Record<string, string>
    if (locale === "en") english = messages
    for (const key of keys) {
      assert(Object.prototype.hasOwnProperty.call(messages, key), `${locale} must define ${key}; English fallback is not coverage`)
      assert.deepEqual(placeholders(messages[key]), placeholders(english[key]), `${locale} ${key}`)
    }
  }
})
