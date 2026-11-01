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

test("deferred Linux rollback explains both safe retry conditions in every locale", async () => {
  const conditions = {
    en: ["user session", "processes have exited", "safe restoration"],
    fr: ["session utilisateur", "processus OpenCode libérés sont terminés", "restauration sûre"],
    de: ["Benutzersitzung", "OpenCode-Prozesse beendet", "sicheres Zurücksetzen"],
    es: ["sesión de usuario", "terminado los procesos OpenCode liberados", "restauración segura"],
    he: ["הפעלת משתמש", "תהליכי OpenCode ששוחררו הסתיימו", "בבטחה"],
    ja: ["ユーザーセッション", "OpenCode プロセスが終了", "安全に復元"],
    ne: ["प्रयोगकर्ता सत्र", "OpenCode प्रक्रियाहरू समाप्त", "सुरक्षित पुनर्स्थापना"],
    ru: ["пользовательский сеанс", "процессы OpenCode завершились", "безопасным"],
    tr: ["kullanıcı oturumu", "OpenCode süreçleri sonlandığında", "güvenli geri alma"],
    "zh-Hans": ["用户会话", "OpenCode 进程退出", "安全恢复"],
  }
  for (const [locale, fragments] of Object.entries(conditions)) {
    const { serviceSupervisionMessages: messages } = await import(`./messages/${locale}/service-supervision.ts`)
    for (const fragment of fragments)
      assert.ok(messages["settings.supervision.cause.linux-linger-deferred"].includes(fragment), `${locale}: ${fragment}`)
  }
})
