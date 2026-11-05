import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("live-only interruption reasons have the same nonempty keys/placeholders in all ten locales and current help", async () => {
  const locales = ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]
  let baseline: [string, string[]][] | undefined
  for (const locale of locales) {
    const source = await readFile(new URL(`messages/${locale}/session.ts`, import.meta.url), "utf8")
    const entries = [...source.matchAll(/"(opencodeServers\.pending\.[\w]+)": ("(?:\\.|[^"\\])*")/g)]
      .map(([, key, value]) => [key, JSON.parse(value)] as const)
    assert.equal(entries.length, 4, locale)
    const verification = [...source.matchAll(/"(formVerification\.[\w]+)": ("(?:\\.|[^"\\])*")/g)].map(([, key, value]) => [key, JSON.parse(value)] as const)
    assert.equal(verification.length, 7, locale)
    assert.deepEqual(verification.map(([key]) => key).sort(), ["answered", "cancelled", "check", "checking", "indeterminate", "pending", "stale"].map(key => `formVerification.${key}`).sort(), locale)
    assert(verification.every(([, value]) => value.trim().length > 0 && !/\{\w+\}/.test(value)), locale)
    assert(entries.every(([, value]) => value.trim().length > 0), locale)
    const shapes = entries.map(([key, value]) => [key, [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()] as [string, string[]]).sort()
    if (baseline) assert.deepEqual(shapes, baseline, locale)
    else baseline = shapes
    const help = await readFile(new URL(`../../../../../docs/help/${locale}/permissions.md`, import.meta.url), "utf8")
    assert(help.includes(verification.find(([key]) => key === "formVerification.check")![1]), locale)
  }
})
