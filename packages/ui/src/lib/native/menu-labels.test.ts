import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { NATIVE_MENU_LABEL_KEYS, nativeMenuLabels } from "./menu-labels"
import { DEFAULT_NATIVE_MENU_LABELS } from "./menu-labels-en"

const locales = {
  en: async () => (await import("../i18n/messages/en")).enMessages,
  fr: async () => (await import("../i18n/messages/fr")).frMessages,
  de: async () => (await import("../i18n/messages/de")).deMessages,
  es: async () => (await import("../i18n/messages/es")).esMessages,
  ja: async () => (await import("../i18n/messages/ja")).jaMessages,
  "zh-Hans": async () => (await import("../i18n/messages/zh-Hans")).zhHansMessages,
  ru: async () => (await import("../i18n/messages/ru")).ruMessages,
  tr: async () => (await import("../i18n/messages/tr")).trMessages,
  he: async () => (await import("../i18n/messages/he")).heMessages,
  ne: async () => (await import("../i18n/messages/ne")).neMessages,
} as const

describe("native menu labels", () => {
  it("are translated in every locale", async () => {
    for (const [locale, load] of Object.entries(locales)) {
      const messages: Record<string, string> = await load()
      const labels = nativeMenuLabels((key) => messages[key] ?? "")
      for (const [name, label] of Object.entries(labels)) {
        assert.ok(label.trim() && label.length <= 200, `${locale}: ${name}`)
      }
    }
  })

  it("keep the Tauri host's English defaults identical to the English messages", () => {
    const source = readFileSync(new URL("../../../../tauri-app/src-tauri/src/menu_labels.rs", import.meta.url), "utf8")
    const block = source.slice(source.indexOf("pub(crate) const DEFAULTS"), source.indexOf("];"))
    const rust = Object.fromEntries([...block.matchAll(/\("(\w+)", "((?:[^"\\]|\\.)*)"\)/g)].map(([, key, text]) => [key, text]))
    assert.deepEqual(rust, DEFAULT_NATIVE_MENU_LABELS)
    assert.deepEqual(Object.keys(rust).sort(), Object.keys(NATIVE_MENU_LABEL_KEYS).sort())
  })
})
