import assert from "node:assert/strict"
import { test } from "node:test"
import type { SupervisionSettingsResponse } from "../../../../server/src/api-types"
import { serviceSupervisionMessages as en } from "./messages/en/service-supervision"

// Compile-time coverage of every fixed server cause; runtime locale checks also
// catch missing translations and placeholders before they silently fall back.
const covered: Record<`settings.supervision.cause.${NonNullable<SupervisionSettingsResponse["cause"]>}`, string> = en
test("every supervision cause, state and placeholder is translated in all ten locales", async () => {
  assert.equal(Object.keys(covered).filter(key => key.includes(".cause.")).length, 19)
  for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const { serviceSupervisionMessages: messages } = await import(`./messages/${locale}/service-supervision.ts`)
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort(), locale)
    for (const [key, value] of Object.entries(en)) {
      assert.ok(typeof messages[key] === "string" && messages[key].trim(), `${locale}: ${key}`)
      assert.deepEqual(messages[key].match(/\{\w+\}/g), value.match(/\{\w+\}/g), `${locale}: ${key}`)
    }
  }
})
