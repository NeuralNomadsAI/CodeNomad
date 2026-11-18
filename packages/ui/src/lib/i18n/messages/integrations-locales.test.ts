import assert from "node:assert/strict"
import test from "node:test"
import { integrationMessages as de } from "./de/integrations"
import { integrationMessages as en } from "./en/integrations"
import { integrationMessages as es } from "./es/integrations"
import { integrationMessages as fr } from "./fr/integrations"
import { integrationMessages as he } from "./he/integrations"
import { integrationMessages as ja } from "./ja/integrations"
import { integrationMessages as ne } from "./ne/integrations"
import { integrationMessages as ru } from "./ru/integrations"
import { integrationMessages as tr } from "./tr/integrations"
import { integrationMessages as zhHans } from "./zh-Hans/integrations"

const locales = { de, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans }
const placeholders = (value: string) => [...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort()

test("integration messages exist in all ten locales with the same keys and placeholders", () => {
  const keys = Object.keys(en)
  for (const [locale, messages] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(messages), keys, `${locale}: same keys, same order`)
    for (const key of keys) {
      const value = (messages as Record<string, string>)[key]!
      assert.ok(value.trim(), `${locale}: ${key}`)
      assert.deepEqual(placeholders(value), placeholders((en as Record<string, string>)[key]!), `${locale}: ${key} placeholders`)
    }
  }
})

test("integration labels stay terse: at most two sentences, no paths", () => {
  for (const [locale, messages] of Object.entries({ en, ...locales })) {
    for (const [key, value] of Object.entries(messages as Record<string, string>)) {
      assert.ok((value.match(/[.!?。！？](\s|$)/g) ?? []).length <= 2, `${locale}: ${key} is short`)
      assert.equal(/[\\/]|~\//.test(value), false, `${locale}: ${key} names no path`)
    }
  }
})
