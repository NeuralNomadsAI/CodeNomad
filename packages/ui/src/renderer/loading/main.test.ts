import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

describe("Tauri loading navigation authority", () => {
  it("leaves ready navigation to the native host", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")

    assert.doesNotMatch(source, /window\.location\.(?:replace|assign)/)
    assert.doesNotMatch(source, /listen\(["']cli:ready["']/)
    assert.match(source, /invoke<CliStatus>\(["']cli_get_status["']\)/)
  })
})

it("provides the real startup labels and removes phrase keys in every locale", async () => {
  for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const { loadingScreenMessages: messages } = await import(`../../lib/i18n/messages/${locale}/loadingScreen.ts`)
    for (const state of ["loading", "starting", "ready", "stopped", "issue"]) {
      assert.ok(messages[`loadingScreen.status.${state}`]?.trim(), `${locale}: ${state}`)
    }
    assert.ok(Object.keys(messages).every(key => !key.startsWith("loadingScreen.phrases.") && key !== "loadingScreen.actions.showAnother"), locale)
  }
})
