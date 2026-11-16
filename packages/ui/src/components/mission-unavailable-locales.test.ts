import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

test("unavailable Missions actions and reload confirmation are localized and documented", async () => {
  for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const { missionMessages: missions } = await import(`../lib/i18n/messages/${locale}/missions.ts`)
    const { settingsMessages: settings } = await import(`../lib/i18n/messages/${locale}/settings.ts`)
    const help = await readFile(new URL(`../../../../docs/help/${locale}/missions.md`, import.meta.url), "utf8")
    for (const key of ["missions.control.unavailable.openCode", "missions.control.unavailable.diagnostics"]) {
      assert.ok(missions[key]?.trim(), `${locale}:${key}`)
      assert.ok(help.includes(`**${missions[key]}**`), `${locale} help: ${key}`)
    }
    assert.ok(settings["settings.opencode.setup.reloadDescription"]?.trim(), `${locale}: reload confirmation`)
  }
})
