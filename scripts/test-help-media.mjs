import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

// Concrete copy oracle for the media boundary, rather than a translation heuristic.
const browserManaged = {
  en: "Image dimensions and decoded-image memory are managed by the browser; device uploads retain separate budgets.",
  fr: "Les dimensions d’image et la mémoire de décodage sont gérées par le navigateur ; les envois depuis l’appareil conservent leurs budgets propres.",
  de: "Bildabmessungen und der Speicher für dekodierte Bilder werden vom Browser verwaltet; Uploads vom Gerät behalten ihre eigenen Budgets.",
  es: "El navegador gestiona las dimensiones de imagen y la memoria de las imágenes decodificadas; los envíos desde el dispositivo mantienen sus propios presupuestos.",
  he: "ממדי התמונות וזיכרון פענוח התמונות מנוהלים על ידי הדפדפן; להעלאות מהמכשיר נשארים תקציבים נפרדים.",
  ja: "画像の寸法と画像デコード時のメモリはブラウザーが管理し、端末からのアップロードには独立した容量制限があります。",
  ne: "तस्बिरका आयाम र डिकोड गरिएको तस्बिरको मेमोरी ब्राउजरले व्यवस्थापन गर्छ; उपकरणबाट गरिने अपलोडका आफ्नै बजेट कायम रहन्छन्।",
  ru: "Размеры изображений и память декодированных изображений управляются браузером; загрузки с устройства сохраняют отдельные бюджеты.",
  tr: "Görsel boyutları ve çözümlenen görsellerin belleği tarayıcı tarafından yönetilir; cihazdan yüklemelerin kendi bütçeleri korunur.",
  "zh-Hans": "图片尺寸和解码图片所需的内存由浏览器管理；设备上传仍受独立预算约束。",
}

test("security copy assigns decoded dimensions and memory to the browser, separately from device uploads, in ten locales", async () => {
  for (const [locale, sentence] of Object.entries(browserManaged)) {
    const source = await readFile(new URL(`../docs/help/${locale}/security.md`, import.meta.url), "utf8")
    assert.ok(source.split(/\r?\n\r?\n/)[1].endsWith(sentence), locale)
    const uriLimit = locale === "fr" ? "8 Mio" : locale === "ru" ? "8 МиБ" : "8 MiB"
    assert.ok(source.includes("16 MiB") && source.includes(uriLimit), locale)
  }
})
