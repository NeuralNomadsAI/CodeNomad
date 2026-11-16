import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

test("unavailable Missions actions and reload confirmation are localized and documented", async () => {
  const interruption = { en: "can interrupt", fr: "peut interrompre", de: "kann aktive Arbeit", es: "puede interrumpir",
    he: "עלולה לקטוע", ja: "中断する場合があります", ne: "रोकिन सक्छ", ru: "может прервать", tr: "kesintiye uğratabilir", "zh-Hans": "可能中断" }
  for (const [locale, possible] of Object.entries(interruption)) {
    const { missionMessages: missions } = await import(`../lib/i18n/messages/${locale}/missions.ts`)
    const { settingsMessages: settings } = await import(`../lib/i18n/messages/${locale}/settings.ts`)
    const help = await readFile(new URL(`../../../../docs/help/${locale}/missions.md`, import.meta.url), "utf8")
    for (const key of ["missions.control.unavailable.openCode", "missions.control.unavailable.diagnostics"]) {
      assert.ok(missions[key]?.trim(), `${locale}:${key}`)
      assert.ok(help.includes(`**${missions[key]}**`), `${locale} help: ${key}`)
    }
    assert.ok(settings["settings.opencode.setup.reloadDescription"]?.includes(possible), `${locale}: reload can interrupt work`)
    const runtimeHelp = await readFile(new URL(`../../../../docs/help/${locale}/opencode.md`, import.meta.url), "utf8")
    assert.equal(runtimeHelp.split(possible).length - 1, 2, `${locale}: table and confirmation describe possible interruption`)
  }
})
