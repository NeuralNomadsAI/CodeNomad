import assert from "node:assert/strict"
import test from "node:test"
import { deMessages } from "./de"
import { enMessages } from "./en"
import { esMessages } from "./es"
import { frMessages } from "./fr"
import { heMessages } from "./he"
import { jaMessages } from "./ja"
import { neMessages } from "./ne"
import { ruMessages } from "./ru"
import { trMessages } from "./tr"
import { zhHansMessages } from "./zh-Hans"

const voiceKeys = (messages: Record<string, string>) => Object.keys(messages)
  .filter(key => key.startsWith("settings.voice.") || key.startsWith("voice.") || key === "settings.speech.testInput.action").sort()
const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort()

test("all ten locales translate voice settings, consent, states and commands", () => {
  const keys = voiceKeys(enMessages)
  for (const [locale, messages] of Object.entries({
    de: deMessages, es: esMessages, fr: frMessages, he: heMessages, ja: jaMessages,
    ne: neMessages, ru: ruMessages, tr: trMessages, "zh-Hans": zhHansMessages,
  })) {
    assert.deepEqual(voiceKeys(messages), keys, locale)
    for (const key of keys) {
      const value = messages[key]
      assert.ok(value?.trim(), `${locale}: ${key}`)
      assert.deepEqual(placeholders(value), placeholders(enMessages[key]!), `${locale}: ${key}`)
    }
  }
})
