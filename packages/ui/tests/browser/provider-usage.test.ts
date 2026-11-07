import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import type { OpenCodeConsoleUsage } from "../../../server/src/api-types-provider-usage"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  const shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, cacheDir: cache.cacheDir, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
     plugins: [shutdown.plugin, solid(), { name: "provider-usage-fixture", configureServer(vite) {
      vite.middlewares.use("/api/events", (req, res) => {
        res.setHeader("Content-Type", "text/event-stream")
        res.write(": connected\n\n")
        req.on("close", () => res.end())
      })
      vite.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await vite.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/provider-usage.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await server?.close(); await cache?.dispose() } })

async function prepare(page: Page) {
  const requests: Route[] = []
  const errors: string[] = []
  let uiConfig = { settings: {} }
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname === "/api/events") return route.continue()
    if (new URL(route.request().url()).pathname.startsWith("/api/usage/")) { requests.push(route); return }
    if (new URL(route.request().url()).pathname === "/api/storage/config/ui") {
      if (route.request().method() === "PATCH") uiConfig = { settings: { ...uiConfig.settings, ...route.request().postDataJSON().settings } }
      return route.fulfill({ json: uiConfig })
    }
    return route.fulfill({ contentType: "application/json", body: "{}" })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).usageFixture))
  return { requests, errors }
}
const fulfill = (route: Route, usedPercent: number) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
  requestedProviderId: "openai", providerId: "codex", providerName: "Codex", supported: true, configured: true, ok: true, fetchedAt: Date.now(),
  windows: { "5h": { usedPercent, remainingPercent: 100 - usedPercent, windowSeconds: 18000, resetAt: null } },
}) })

test("provider usage window keys stay aligned in all ten locales without fallback", async () => {
  const { settingsMessages: english } = await import("../../src/lib/i18n/messages/en/settings")
  const windowKeys = (messages: Record<string, string>) => Object.keys(messages).filter(key => key.startsWith("providerUsage.windows.")).sort()
  for (const locale of ["en", "de", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const { settingsMessages } = await import(new URL(`../../src/lib/i18n/messages/${locale}/settings.ts`, import.meta.url).href)
    assert.deepEqual(windowKeys(settingsMessages), windowKeys(english), locale)
    for (const key of windowKeys(english)) assert.ok(settingsMessages[key].trim(), `${locale}: ${key}`)
    const help = await readFile(new URL(`../../../../docs/help/${locale}/providers.md`, import.meta.url), "utf8")
    assert.ok(help.includes(settingsMessages["providerUsage.unavailable"]), `${locale}: help uses the shown unavailable label`)
  }
})

for (const [locale, usedTemplate, creditsTemplate, unlimited] of [
  ["en-US", "{used} / {limit} used", "Credits used: {used}", "Unlimited"],
  ["fr-FR", "{used} / {limit} utilisés", "Crédits utilisés : {used}", "Illimité"],
  ["de-DE", "{used} / {limit} verbraucht", "Verbrauchte Credits: {used}", "Unbegrenzt"],
  ["es-ES", "{used} / {limit} usados", "Créditos usados: {used}", "Ilimitado"],
  ["he-IL", "{used} / {limit} נוצלו", "נקודות זכות שנוצלו: {used}", "ללא הגבלה"],
  ["ja-JP", "{used} / {limit} 使用済み", "使用済みクレジット: {used}", "無制限"],
  ["ne-NP", "{used} / {limit} प्रयोग भयो", "प्रयोग भएका क्रेडिट: {used}", "असीमित"],
  ["ru-RU", "{used} / {limit} использовано", "Использовано кредитов: {used}", "Без ограничений"],
  ["tr-TR", "{used} / {limit} kullanıldı", "Kullanılan kredi: {used}", "Sınırsız"],
  ["zh-CN", "已使用 {used} / {limit}", "已用点数：{used}", "无限制"],
]) test(`Copilot renders localized consumption, unlimited credits and plan (${locale})`, async () => {
  const page = await browser.newPage({ locale })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    const base = { requestedProviderId: "github-copilot", providerId: "github-copilot", providerName: "GitHub Copilot",
      supported: true, configured: true, ok: true, fetchedAt: Date.now() }
    const quotaWindow = { usedPercent: null, remainingPercent: null, resetAt: null, windowSeconds: null }
    await requests[0].fulfill({ json: { ...base, copilotPlan: "enterprise", windows: {
      premium: { ...quotaWindow, usedPercent: 25.75, remainingPercent: 74.25, consumption: { used: 25.75, limit: 100 } },
      chat: { ...quotaWindow, consumption: { creditsUsed: 1234.125 } },
      credits: { ...quotaWindow, consumption: { creditsUsed: 1 } },
      billing_cycle: { ...quotaWindow, consumption: { creditsUsed: 0.5 } },
      completions: { ...quotaWindow, consumption: { unlimited: true } },
    } } })
    const formatted = await page.evaluate(locale => {
      const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 8 })
      return [25.75, 100, 1234.125, 1, 0.5].map(value => number.format(value))
    }, locale === "zh-CN" ? "zh-Hans" : locale)
    await page.getByText(usedTemplate.replace("{used}", formatted[0]).replace("{limit}", formatted[1]), { exact: true }).waitFor()
    for (const value of formatted.slice(2)) assert.equal(
      await page.getByText(creditsTemplate.replace("{used}", value), { exact: true }).count(), 1,
      "credit wording works for one and fractional values without number agreement",
    )
    await page.getByText(unlimited, { exact: true }).waitFor()
    await page.getByText("GitHub Copilot · Enterprise", { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").count(), 1, "unlimited pools never get a percentage bar")
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "26")
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched"))
    await waitRequests(requests, 2)
    assert.equal(await page.getByText("GitHub Copilot · Enterprise", { exact: true }).count(), 0)
    await requests[1].fulfill({ json: { ...base, windows: { completions: { ...quotaWindow, consumption: { unlimited: true } } } } })
    await page.getByText("GitHub Copilot", { exact: true }).waitFor()
    assert.equal(await page.getByText(/providerUsage\.copilotPlans/).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const kind of ["consumption", "money"] as const) test(`Hebrew ${kind} ratios isolate left-to-right numbers inside right-to-left text`, async () => {
  const page = await browser.newPage({ locale: "he-IL" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await requests[0].fulfill({ json: {
      requestedProviderId: "github-copilot", providerId: "github-copilot", providerName: "GitHub Copilot",
      supported: true, configured: true, ok: true, fetchedAt: Date.now(), windows: { premium: {
        usedPercent: 25.75, remainingPercent: 74.25, resetAt: null, windowSeconds: null,
        ...(kind === "consumption" ? { consumption: { used: 25.75, limit: 100 } } : { balanceUSD: { remaining: 75.5, total: 100 } }),
      } },
    } })
    await page.getByRole("progressbar").waitFor()
    await page.getByText("בקשות פרימיום", { exact: true }).waitFor()
    const ratio = page.locator("[data-usage] span > bdi")
    assert.equal(await ratio.count(), 1, "the complete numeric ratio has its own bidi isolate")
    assert.equal(await ratio.getAttribute("dir"), "ltr")
    const layout = await ratio.evaluate(element => {
      const text = element.textContent!
      const slash = text.indexOf("/")
      const used = text.search(/[0-9]/)
      const limit = slash + 1 + text.slice(slash + 1).search(/[0-9]/)
      const [usedX, limitX] = [used, limit].map(offset => {
        const range = document.createRange()
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          if (offset < node.textContent!.length) {
            range.setStart(node, offset)
            range.setEnd(node, offset + 1)
            break
          }
          offset -= node.textContent!.length
        }
        return range.getBoundingClientRect().x
      })
      return { direction: getComputedStyle(element).direction, bidi: getComputedStyle(element).unicodeBidi,
        surroundingDirection: getComputedStyle(element.parentElement!).direction, usedX, limitX }
    })
    assert.equal(layout.direction, "ltr")
    assert.equal(layout.bidi, "isolate")
    assert.equal(layout.surroundingDirection, "rtl")
    assert.ok(layout.usedX < layout.limitX, "used/remaining stays visually before the limit/total")
    if (kind === "consumption") await page.getByText("25.75 / 100 נוצלו", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, keyLimit] of [["en-US", "Key Limit"], ["de-DE", "Schlüssellimit"]]) {
  for (const providerId of ["openrouter", "github-copilot"]) test(`${providerId} labels keep whole words and values stack at 200px (${locale})`, async () => {
    const page = await browser.newPage({ locale, viewport: { width: 200, height: 400 } })
    try {
      const { requests, errors } = await prepare(page)
      await waitRequests(requests, 1)
      const openrouter = providerId === "openrouter"
      await requests[0].fulfill({ json: {
        requestedProviderId: providerId, providerId, providerName: openrouter ? "OpenRouter" : "GitHub Copilot",
        supported: true, configured: true, ok: true, fetchedAt: Date.now(), windows: {
          [openrouter ? "key_limit" : "chat"]: {
            usedPercent: null, remainingPercent: null, resetAt: null, windowSeconds: null,
            ...(openrouter ? { balanceUSD: { remaining: 7550500.5, total: 10000000 } } : { consumption: { creditsUsed: 1234567890.125 } }),
          },
        },
      } })
      const label = page.getByText(openrouter ? keyLimit : "Chat", { exact: true })
      await label.waitFor()
      const layout = await label.evaluate(element => {
        const label = element as HTMLElement
        const value = label.nextElementSibling!.querySelector<HTMLElement>("span")!
        const panel = document.querySelector<HTMLElement>("[data-usage]")!
        const text = label.firstChild!
        const words = Array.from(label.textContent!.matchAll(/\S+/g), match => {
          const range = document.createRange()
          range.setStart(text, match.index!)
          range.setEnd(text, match.index! + match[0].length)
          return { word: match[0], lines: new Set(Array.from(range.getClientRects(), rect => rect.top)).size }
        })
        return { words, labelWidth: label.clientWidth, labelScrollWidth: label.scrollWidth,
          valueWidth: value.clientWidth, valueScrollWidth: value.scrollWidth,
          labelBottom: label.getBoundingClientRect().bottom, valueTop: value.getBoundingClientRect().top,
          panelWidth: panel.getBoundingClientRect().width, panelClientWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth,
          overflow: getComputedStyle(value).overflow, textOverflow: getComputedStyle(value).textOverflow }
      })
      assert.equal(layout.panelWidth, 200)
      for (const word of layout.words) assert.equal(word.lines, 1, `${word.word} stays on one line`)
      assert.ok(layout.labelScrollWidth <= layout.labelWidth, "the label fits without overflow")
      assert.ok(layout.valueScrollWidth <= layout.valueWidth, "the complete value fits without overflow")
      assert.ok(layout.panelScrollWidth <= layout.panelClientWidth, "the panel fits its container")
      assert.ok(layout.valueTop >= layout.labelBottom, "the value moves below the label when both cannot fit")
      assert.notEqual(layout.overflow, "hidden")
      assert.notEqual(layout.textOverflow, "ellipsis")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("German monetary ratios wrap at 200px without overflow or truncation", async () => {
  const page = await browser.newPage({ locale: "de-DE", viewport: { width: 200, height: 400 } })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await requests[0].fulfill({ json: {
      requestedProviderId: "openrouter", providerId: "openrouter", providerName: "OpenRouter",
      supported: true, configured: true, ok: true, fetchedAt: Date.now(), windows: { key_limit: {
        usedPercent: 24.495, remainingPercent: 75.505, resetAt: null, windowSeconds: null,
        balanceUSD: { remaining: 7550500000.5, total: 10000000000 },
      } },
    } })
    const value = page.getByText("7.550.500.000,50 $ / 10.000.000.000,00 $", { exact: true })
    await value.waitFor()
    const layout = await value.evaluate(element => {
      const panel = document.querySelector<HTMLElement>("[data-usage]")!
      const box = element.closest("span")!
      const range = document.createRange()
      range.selectNodeContents(element)
      return { width: panel.getBoundingClientRect().width, scrollWidth: panel.scrollWidth, panelClientWidth: panel.clientWidth,
        clientWidth: box.clientWidth, valueScrollWidth: box.scrollWidth,
        lines: new Set(Array.from(range.getClientRects(), rect => rect.top)).size,
        whiteSpace: getComputedStyle(box).whiteSpace, overflow: getComputedStyle(box).overflow,
        textOverflow: getComputedStyle(box).textOverflow }
    })
    assert.equal(layout.width, 200)
    assert.ok(layout.scrollWidth <= layout.panelClientWidth, "the panel fits its 200px container")
    assert.ok(layout.valueScrollWidth <= layout.clientWidth, "the entire ratio fits its wrapping box")
    assert.ok(layout.lines > 1, "the complete monetary ratio wraps onto multiple lines")
    assert.equal(layout.whiteSpace, "normal")
    assert.notEqual(layout.overflow, "hidden")
    assert.notEqual(layout.textOverflow, "ellipsis")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, label, invalid] of [
  ["en-US", "Key Limit", "Invalid provider base URL. Configure a public HTTPS URL."],
  ["fr-FR", "Plafond de la clé", "URL de base du fournisseur invalide. Configurez une URL HTTPS publique."],
  ["de-DE", "Schlüssellimit", "Ungültige Anbieter-Basis-URL. Konfigurieren Sie eine öffentliche HTTPS-URL."],
  ["es-ES", "Límite de la clave", "URL base del proveedor no válida. Configura una URL HTTPS pública."],
  ["he-IL", "מגבלת המפתח", "כתובת הבסיס של הספק אינה תקינה. יש להגדיר כתובת HTTPS ציבורית."],
  ["ja-JP", "キーの上限", "プロバイダーのベース URL が無効です。公開 HTTPS URL を設定してください。"],
  ["ne-NP", "कुञ्जीको सीमा", "प्रदायकको आधार URL अमान्य छ। सार्वजनिक HTTPS URL कन्फिगर गर्नुहोस्।"],
  ["ru-RU", "Лимит ключа", "Недопустимый базовый URL провайдера. Укажите публичный HTTPS URL."],
  ["tr-TR", "Anahtar sınırı", "Sağlayıcının temel URL'si geçersiz. Herkese açık bir HTTPS URL'si yapılandırın."],
  ["zh-CN", "密钥限额", "提供商基础 URL 无效。请配置公共 HTTPS URL。"],
]) test(`OpenRouter renders the localized Key Limit, USD values and invalid destination status (${locale})`, async () => {
  const page = await browser.newPage({ locale })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    const base = { requestedProviderId: "openrouter", providerId: "openrouter", providerName: "OpenRouter",
      supported: true, configured: true, fetchedAt: Date.now() }
    await requests[0].fulfill({ json: { ...base, ok: true, windows: { key_limit: {
      usedPercent: 25, remainingPercent: 75, windowSeconds: null, resetAt: null, balanceUSD: { remaining: 75.5, total: 100 },
    } } } })
    await page.getByText(label, { exact: true }).waitFor()
    const numberLocale = locale === "zh-CN" ? "zh-Hans" : locale
    // Compare against the browser's ICU data (currency symbols vary across ICU versions).
    const amount = await page.evaluate(locale => {
      const money = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" })
      return `${money.format(75.5)} / ${money.format(100)}`
    }, numberLocale)
    await page.getByText(amount, { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "25")
    assert.equal(await page.getByText("key_limit", { exact: true }).count(), 0)
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 2)
    await requests[1].fulfill({ json: { ...base, ok: false, windows: {}, unavailableReason: "invalid-base-url" } })
    await page.getByRole("status").getByText(invalid, { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, expired, action] of [
  ["en-US", "The OpenCode Go key has expired.", "Create a new key in OpenCode Console, then replace it"],
  ["fr-FR", "La clé OpenCode Go a expiré.", "Créer une nouvelle clé dans OpenCode Console, puis la remplacer"],
  ["de-DE", "Der OpenCode-Go-Schlüssel ist abgelaufen.", "Neuen Schlüssel in OpenCode Console erstellen und ersetzen"],
  ["es-ES", "La clave de OpenCode Go ha caducado.", "Crear una clave nueva en OpenCode Console y sustituirla"],
  ["he-IL", "תוקף מפתח OpenCode Go פג.", "יצירת מפתח חדש ב-OpenCode Console והחלפת המפתח"],
  ["ja-JP", "OpenCode Go キーの有効期限が切れています。", "OpenCode Console で新しいキーを作成して置き換える"],
  ["ne-NP", "OpenCode Go कुञ्जीको म्याद सकिएको छ।", "OpenCode Console मा नयाँ कुञ्जी बनाएर पुरानो बदल्नुहोस्"],
  ["ru-RU", "Срок действия ключа OpenCode Go истёк.", "Создать новый ключ в OpenCode Console и заменить старый"],
  ["tr-TR", "OpenCode Go anahtarının süresi doldu.", "OpenCode Console'da yeni bir anahtar oluşturup eskisini değiştirin"],
  ["zh-CN", "OpenCode Go 密钥已过期。", "在 OpenCode Console 中创建新密钥并替换旧密钥"],
]) test(`Go wallet is opt-in localized USD and expired keys have an accessible fixed recovery link (${locale})`, async () => {
  const page = await browser.newPage({ locale })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    const base = { requestedProviderId: "opencode-go", providerId: "opencode-go", providerName: "OpenCode Go", supported: true,
      configured: true, ok: true, fetchedAt: Date.now() }
    const wallet = { usedPercent: null, remainingPercent: null, resetAt: null, windowSeconds: null, balanceUSD: { remaining: 1.5 } }
    const format = () => page.evaluate(locale => new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(1.5), locale === "zh-CN" ? "zh-Hans" : locale)
    await requests[0].fulfill({ json: { ...base, windows: { credits_balance: wallet } } })
    await page.locator(".right-panel-empty-text").waitFor()
    assert.equal(await page.getByText("OpenCode Go", { exact: true }).count(), 0, "hidden balance alone cannot produce an empty successful card")
    await page.evaluate(() => (window as any).usageFixture.creditBalance(true))
    await page.getByText(await format(), { exact: true }).waitFor()
    await page.getByText("OpenCode Go", { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").count(), 0, "a wallet has no quota percentage")
    await page.evaluate(() => (window as any).usageFixture.creditBalance(false))
    await page.locator(".right-panel-empty-text").waitFor()
    assert.equal(await page.getByText(await format(), { exact: true }).count(), 0)
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 2)
    await requests[1].fulfill({ json: { ...base, ok: false, windows: {}, unavailableReason: "opencode-go-key-expired", unavailableAction: "opencode-go-new-key" } })
    await page.getByRole("status").getByText(expired, { exact: true }).waitFor()
    const link = page.getByRole("link", { name: action, exact: true })
    assert.equal(await link.getAttribute("href"), "https://opencode.ai/console/login")
    assert.equal(await link.getAttribute("target"), "_blank")
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer")
    assert.equal(await link.evaluate(el => getComputedStyle(el).textDecorationLine), "underline")
    await page.keyboard.press("Tab")
    assert.equal(await link.evaluate(el => document.activeElement === el), true)
    assert.notEqual(await link.evaluate(el => getComputedStyle(el).outlineStyle), "none")
    await page.evaluate(() => {
      ;(window as any).openedUsageLinks = []
      window.open = ((...args: unknown[]) => { (window as any).openedUsageLinks.push(args); return null }) as typeof window.open
    })
    await page.keyboard.press("Enter")
    assert.deepEqual(await page.evaluate(() => (window as any).openedUsageLinks), [["https://opencode.ai/console/login", "_blank", "noopener,noreferrer"]])
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched"))
    await waitRequests(requests, 3)
    assert.equal(await link.count(), 0)
    await fulfill(requests[2], 25)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("status").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, monthly, monthlyCode, used] of [
  ["en-US", "Monthly", "Monthly coding", "30% used"],
  ["fr-FR", "Mensuel", "Code mensuel", "30 % utilisé"],
  ["de-DE", "Monatlich", "Monatliches Coding", "30 % verwendet"],
  ["es-ES", "Mensual", "Programación mensual", "30 % usado"],
  ["he-IL", "חודשי", "תכנות חודשי", "30% בשימוש"],
  ["ja-JP", "月間", "月間コーディング", "30% 使用"],
  ["ne-NP", "मासिक", "मासिक कोडिङ", "30% प्रयोग भयो"],
  ["ru-RU", "За месяц", "Код за месяц", "Использовано 30%"],
  ["tr-TR", "Aylık", "Aylık kodlama", "%30 kullanıldı"],
  ["zh-CN", "每月", "每月编程", "已使用 30%"],
]) test(`Kimi monthly caps use localized common consumed-percentage rendering (${locale})`, async () => {
  const page = await browser.newPage({ locale })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await requests[0].fulfill({ json: {
      requestedProviderId: "kimi-code-plan-cn", providerId: "kimi-for-coding", providerName: "Kimi for Coding",
      supported: true, configured: true, ok: true, fetchedAt: Date.now(), windows: {
        monthly: { usedPercent: 30, remainingPercent: 70, windowSeconds: null, resetAt: null },
        "monthly-code": { usedPercent: 30, remainingPercent: 70, windowSeconds: null, resetAt: null },
      },
    } })
    await page.getByText(monthly, { exact: true }).waitFor()
    await page.getByText(monthlyCode, { exact: true }).waitFor()
    const percent = await page.evaluate(locale => new Intl.NumberFormat(locale).format(30), locale)
    assert.equal(await page.getByText(used.replace("30", percent), { exact: true }).count(), 2)
    assert.deepEqual(await page.getByRole("progressbar").evaluateAll(bars => bars.map(bar => bar.getAttribute("aria-valuenow"))), ["30", "30"])
    assert.equal(await page.getByText("monthly-code", { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, requestsLabel, perUser, team, usedOnly] of [
  ["en-US", "Requests", "Per-user limit", "Team limit", "7 used"],
  ["fr-FR", "Requêtes", "Plafond par utilisateur", "Plafond de l’équipe", "7 utilisés"],
  ["de-DE", "Anfragen", "Limit pro Nutzer", "Teamlimit", "7 verbraucht"],
  ["es-ES", "Solicitudes", "Límite por usuario", "Límite del equipo", "7 usados"],
  ["he-IL", "בקשות", "מגבלה למשתמש", "מגבלת צוות", "7 נוצלו"],
  ["ja-JP", "リクエスト", "ユーザーごとの上限", "チームの上限", "7 使用済み"],
  ["ne-NP", "अनुरोधहरू", "प्रति प्रयोगकर्ता सीमा", "टोलीको सीमा", "7 प्रयोग भयो"],
  ["ru-RU", "Запросы", "Лимит на пользователя", "Лимит команды", "7 использовано"],
  ["tr-TR", "İstekler", "Kullanıcı başına sınır", "Takım sınırı", "7 kullanıldı"],
  ["zh-CN", "请求", "每用户限额", "团队限额", "已使用 7"],
]) test(`Cursor Enterprise renders scoped cap-only USD rows and nullable request limits (${locale})`, async () => {
  const page = await browser.newPage({ locale })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    const base = { requestedProviderId: "cursor", providerId: "cursor", providerName: "Cursor", supported: true,
      configured: true, ok: true, fetchedAt: Date.now() }
    const quotaWindow = { usedPercent: null, remainingPercent: null, windowSeconds: null, resetAt: null }
    await requests[0].fulfill({ json: { ...base, windows: {
      "requests:gpt-4": { ...quotaWindow, consumption: { used: 7 } },
      per_user_limit: { ...quotaWindow, limitUSD: 250.5 }, team_limit: { ...quotaWindow, limitUSD: 5000 },
    } } })
    await page.getByText(`${requestsLabel} · gpt-4`, { exact: true }).waitFor()
    await page.getByText(perUser, { exact: true }).waitFor()
    await page.getByText(team, { exact: true }).waitFor()
    const amounts = await page.evaluate(locale => {
      const money = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" })
      return [250.5, 5000].map(value => money.format(value))
    }, locale === "zh-CN" ? "zh-Hans" : locale)
    for (const amount of amounts) await page.getByText(amount, { exact: true }).waitFor()
    const seven = await page.evaluate(locale => new Intl.NumberFormat(locale).format(7), locale)
    await page.getByText(usedOnly.replace("7", seven), { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").count(), 0, "cap-only rows never imply zero spend")
    assert.equal(await page.getByText(/0.*\/.*250/).count(), 0)
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 2)
    await requests[1].fulfill({ json: { ...base, windows: {
      "requests:gpt-4": { ...quotaWindow, usedPercent: 25, remainingPercent: 75, consumption: { used: 25, limit: 100 } },
    } } })
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "25")
    assert.equal(await page.getByText(perUser, { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [reason, message] of [
  ["cursor-token-expired", "Cursor token expired. Update CURSOR_ACCESS_TOKEN or CURSOR_TOKEN and restart the backend."],
  ["cursor-team-unavailable", "Cursor team unavailable. Check your team membership."],
  ["cursor-access-denied", "Cursor denied access to team usage. Check your team permissions."],
  ["cursor-usage-unavailable", "Cursor did not provide readable usage or limits."],
]) test(`Cursor ${reason} revokes meters with its distinct actionable status`, async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 2)
    await requests[1].fulfill({ json: { requestedProviderId: "cursor", providerId: "cursor", providerName: "Cursor", supported: true,
      configured: true, ok: false, fetchedAt: Date.now(), windows: {}, unavailableReason: reason } })
    await page.getByRole("status").getByText(message, { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("free-model usage shows an estimate and estimated reset, then clears them on a provider switch", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.select({ providerId: "opencode", modelId: "big-pickle" }))
    await waitRequests(requests, 2)
    assert.equal(new URL(requests[1].request().url()).pathname, "/api/usage/opencode")
    await requests[1].fulfill({ json: {
      requestedProviderId: "opencode", providerId: "opencode-free", providerName: "OpenCode",
      supported: true, configured: true, ok: true, estimated: true, fetchedAt: Date.now(),
      freeEstimate: { requests: 42, reference: 200, exhausted: false },
      windows: { daily: { usedPercent: 21, remainingPercent: 79, windowSeconds: 86400, resetAt: Date.now() + 86400000, valueLabel: "42 / 200" } },
    } })
    await page.getByText("42 / 200", { exact: true }).waitFor()
    await page.getByText("Estimated", { exact: true }).waitFor()
    await page.getByText(/Estimated reset/).waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "21")
    await page.evaluate(() => (window as any).usageFixture.select({ providerId: "openai", modelId: "gpt-5" }))
    await waitRequests(requests, 3)
    assert.equal(await page.getByText(/Estimate:|Estimated reset/).count(), 0)
    await fulfill(requests[2], 30)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByText(/Estimate:|Estimated reset/).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
async function waitRequests(requests: Route[], count: number) {
  const deadline = Date.now() + 5000
  while (requests.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(requests.length, count)
}

test("rendered quota requests carry instance/session identity and stale sessions cannot publish or warm remounts", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    const first = new URL(requests[0].request().url())
    assert.equal(first.searchParams.get("instanceId"), "first")
    assert.equal(first.searchParams.get("sessionId"), "session-a")
    assert.equal(first.searchParams.get("modelId"), "gpt-5")
    await page.evaluate(() => (window as any).usageFixture.select({ instanceId: "second", sessionId: "session-b", directory: "/worktree" }))
    await waitRequests(requests, 2)
    const second = new URL(requests[1].request().url())
    assert.equal(second.searchParams.get("instanceId"), "second")
    assert.equal(second.searchParams.get("sessionId"), "session-b")
    await fulfill(requests[1], 20)
    await page.getByRole("progressbar").waitFor()
    await fulfill(requests[0], 10)
    await page.waitForTimeout(50)
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "20")
    await page.evaluate(() => (window as any).usageFixture.mounted(false))
    await page.locator("[data-usage]").waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).usageFixture.mounted(true))
    await waitRequests(requests, 3)
    assert.equal(await page.getByRole("progressbar").count(), 0, "no global warm snapshot before native account validation")
    await fulfill(requests[2], 30)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "30")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("native account events and reconnect clear old quotas; hidden panels do not fetch", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched", "another-instance"))
    assert.equal(requests.length, 1)
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched"))
    await waitRequests(requests, 2)
    assert.equal(await page.getByRole("progressbar").count(), 0)
    await page.evaluate(() => (window as any).usageFixture.connection("disconnected"))
    await fulfill(requests[1], 20)
    assert.equal(await page.getByRole("progressbar").count(), 0)
    await page.evaluate(() => (window as any).usageFixture.connection("connected"))
    await waitRequests(requests, 3); await fulfill(requests[2], 30)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.active(false))
    await page.evaluate(() => (window as any).usageFixture.event("integration.updated"))
    await page.waitForTimeout(50)
    assert.equal(requests.length, 3)
    await page.evaluate(() => (window as any).usageFixture.active(true))
    await waitRequests(requests, 4); await fulfill(requests[3], 40)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "40")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, message, linkLabel] of [
  ["en-US", "OpenAI does not provide usage for this ChatGPT sign-in method. You can still chat.", "View ChatGPT usage"],
  ["fr-FR", "OpenAI ne permet pas de consulter l'utilisation avec cette méthode de connexion ChatGPT. Les conversations restent disponibles.", "Consulter l’utilisation ChatGPT"],
]) test(`ChatGPT sign-in limitation replaces old quota and clears on account change (${locale})`, async () => {
  const page = await browser.newPage({ locale, viewport: { width: 320, height: 200 } })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched"))
    await waitRequests(requests, 2)
    await requests[1].fulfill({ json: {
      requestedProviderId: "openai", providerId: "codex", providerName: "Codex", supported: true,
      configured: true, ok: false, fetchedAt: Date.now(), windows: {}, unavailableReason: "openai-token-sharing-unsupported",
      unavailableAction: "chatgpt-usage",
    } })
    await page.getByText(message, { exact: true }).waitFor()
    const link = page.getByRole("status").getByRole("link", { name: linkLabel, exact: true })
    await link.waitFor()
    assert.equal(await link.getAttribute("href"), "https://chatgpt.com/settings/usage")
    assert.equal(await link.getAttribute("target"), "_blank")
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer")
    assert.equal(await link.evaluate(el => getComputedStyle(el).textDecorationLine), "underline")
    await page.keyboard.press("Tab")
    assert.equal(await link.evaluate(el => document.activeElement === el), true)
    assert.notEqual(await link.evaluate(el => getComputedStyle(el).outlineStyle), "none")
    assert.equal(await page.getByRole("status").evaluate(el => el.classList.contains("right-panel-empty-text")), false)
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    if (process.env.CODENOMAD_USAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_USAGE_CAPTURE.replace(/\.png$/, `-${locale}.png`) })
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched"))
    await waitRequests(requests, 3)
    assert.equal(await link.count(), 0, "account changes revoke the link before the next quota arrives")
    await fulfill(requests[2], 20)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByText(message, { exact: true }).count(), 0)
    assert.equal(await link.count(), 0)
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "20")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, message] of [
  ["en-US", "MiniMax doesn't share its limits"],
  ["fr-FR", "MiniMax ne partage pas ses limites"],
  ["de-DE", "MiniMax teilt seine Limits nicht mit"],
  ["es-ES", "MiniMax no comparte sus límites"],
  ["he-IL", "MiniMax לא משתפת את המגבלות שלה"],
  ["ja-JP", "MiniMax は上限を公開していません"],
  ["ne-NP", "MiniMax ले आफ्ना सीमाहरू साझा गर्दैन"],
  ["ru-RU", "MiniMax не сообщает свои лимиты"],
  ["tr-TR", "MiniMax sınırlarını paylaşmıyor"],
  ["zh-CN", "MiniMax 不公开其限额"],
]) test(`MiniMax unshared limits replace old quota with a localized status (${locale})`, async () => {
  const page = await browser.newPage({ locale, viewport: { width: 320, height: 200 } })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.select({ providerId: "minimax-coding-plan", modelId: "MiniMax-M*" }))
    await waitRequests(requests, 2)
    assert.equal(new URL(requests[1].request().url()).pathname, "/api/usage/minimax-coding-plan")
    await fulfill(requests[1], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 3)
    await requests[2].fulfill({ json: {
      requestedProviderId: "minimax-coding-plan", providerId: "minimax-coding-plan", providerName: "MiniMax Coding Plan",
      supported: true, configured: true, ok: false, windows: {}, fetchedAt: Date.now(), unavailableReason: "minimax-limits-not-shared",
    } })
    await page.getByRole("status").getByText(message, { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.equal(await page.getByRole("status").getByRole("link").count(), 0)
    assert.equal(await page.getByText(/10\s*%/).count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 4)
    await fulfill(requests[3], 20)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("status").count(), 0)
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "20")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, message] of [
  ["en-US", "Provider error (1001)."],
  ["fr-FR", "Erreur du fournisseur (1001)."],
  ["de-DE", "Anbieterfehler (1001)."],
  ["es-ES", "Error del proveedor (1001)."],
  ["he-IL", "שגיאת ספק (1001)."],
  ["ja-JP", "プロバイダーエラー（1001）。"],
  ["ne-NP", "प्रदायक त्रुटि (1001)।"],
  ["ru-RU", "Ошибка провайдера (1001)."],
  ["tr-TR", "Sağlayıcı hatası (1001)."],
  ["zh-CN", "提供商错误（1001）。"],
]) test(`z.ai business errors replace quotas with a localized status (${locale})`, async () => {
  const page = await browser.newPage({ locale })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.select({ providerId: "zai-coding-plan", modelId: "glm-5" }))
    await waitRequests(requests, 2)
    assert.equal(new URL(requests[1].request().url()).pathname, "/api/usage/zai-coding-plan")
    await requests[1].fulfill({ json: { requestedProviderId: "zai-coding-plan", providerId: "zai-coding-plan", providerName: "z.ai",
      supported: true, configured: true, ok: false, windows: {}, fetchedAt: Date.now(), unavailableReason: "provider-error", providerErrorCode: "1001" } })
    await page.getByRole("status").getByText(message, { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.equal(await page.getByRole("status").getByRole("link").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("public reason cards replace stale quota and open only their fixed accessible destination", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await page.evaluate(() => {
      ;(window as any).openedUsageLinks = []
      window.open = ((...args: unknown[]) => { (window as any).openedUsageLinks.push(args); return null }) as typeof window.open
    })
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 2)
    const failed = { requestedProviderId: "openai", providerId: "codex", providerName: "Codex", supported: true,
      configured: true, ok: false, fetchedAt: Date.now(), windows: {} }
    await requests[1].fulfill({ json: { ...failed, unavailableReason: "openai-token-sharing-unsupported", unavailableAction: "chatgpt-usage" } })
    const link = page.getByRole("link", { name: "View ChatGPT usage" })
    await link.waitFor()
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.equal(await page.getByText("10% used", { exact: true }).count(), 0)
    assert.equal(await link.getAttribute("href"), "https://chatgpt.com/settings/usage")
    assert.equal(await link.getAttribute("target"), "_blank")
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer")
    await page.keyboard.press("Tab")
    assert.equal(await link.evaluate(el => document.activeElement === el), true)
    assert.notEqual(await link.evaluate(el => getComputedStyle(el).outlineStyle), "none")
    await page.keyboard.press("Enter")
    assert.deepEqual(await page.evaluate(() => (window as any).openedUsageLinks), [["https://chatgpt.com/settings/usage", "_blank", "noopener,noreferrer"]])
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 3)
    await requests[2].fulfill({ json: { ...failed, unavailableReason: "provider-error", providerErrorCode: "1001", unavailableAction: "chatgpt-usage" } })
    await page.getByRole("status").getByText("Provider error (1001).", { exact: true }).waitFor()
    assert.equal(await page.getByRole("link").count(), 0, "a different reason cannot inherit an unrelated action")
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("repeated connected notifications preserve quota DOM and in-flight refreshes without compaction or input coupling", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    // Establish both connection identities before publishing their validated quota.
    await page.evaluate(() => (window as any).usageFixture.connection("connected"))
    await waitRequests(requests, 2)
    await page.evaluate(() => (window as any).usageFixture.transport("connected"))
    await waitRequests(requests, 3)
    await fulfill(requests[0], 80); await fulfill(requests[1], 90); await fulfill(requests[2], 10)
    const bar = page.getByRole("progressbar")
    await bar.waitFor()
    const original = await bar.elementHandle()
    await page.evaluate(() => {
      const fixture = (window as any).usageFixture
      for (let i = 0; i < 20; i++) {
        fixture.connection("connected")
        fixture.transport("connected")
      }
      fixture.event("session.compaction.started")
      fixture.event("session.compaction.ended")
    })
    await page.waitForTimeout(50)
    assert.equal(requests.length, 3, "duplicate connectivity and compaction alone do not demand quotas")
    assert.equal(await original!.evaluate(el => el.isConnected), true)
    assert.equal(await bar.getAttribute("aria-valuenow"), "10")

    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 4)
    await page.evaluate(() => {
      const fixture = (window as any).usageFixture
      for (let i = 0; i < 20; i++) {
        fixture.connection("connected")
        fixture.transport("connected")
      }
    })
    assert.equal(await original!.evaluate(el => el.isConnected), true, "a pending refresh cannot reset the display")
    if (process.env.CODENOMAD_USAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_USAGE_CAPTURE })
    await fulfill(requests[3], 20)
    await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "20")
    await page.waitForTimeout(50)
    assert.equal(requests.length, 4, "duplicate connectivity neither cancels nor schedules trailing reads")
    assert.equal(await original!.evaluate(el => el.isConnected), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const boundary of ["native-generation", "native-disconnect", "transport-disconnect", "server-connected"] as const) {
  test(`real ${boundary} boundary still revokes quotas and fences old responses`, async () => {
    const page = await browser.newPage()
    try {
      const { requests, errors } = await prepare(page)
      await waitRequests(requests, 1)
      await page.evaluate(() => (window as any).usageFixture.connection("connected"))
      await waitRequests(requests, 2)
      await page.evaluate(() => (window as any).usageFixture.transport("connected"))
      await waitRequests(requests, 3)
      await fulfill(requests[0], 80); await fulfill(requests[1], 90); await fulfill(requests[2], 10)
      await page.getByRole("progressbar").waitFor()
      await page.evaluate(() => {
        for (let i = 0; i < 5; i++) (window as any).usageFixture.event("provider.updated")
      })
      await waitRequests(requests, 4)
      await page.evaluate(boundary => {
        const fixture = (window as any).usageFixture
        if (boundary === "native-generation") fixture.connection("connected", 2)
        else if (boundary === "native-disconnect") fixture.connection("disconnected")
        else if (boundary === "transport-disconnect") fixture.transport("disconnected")
        else fixture.event("server.connected")
      }, boundary)
      assert.equal(await page.getByRole("progressbar").count(), 0)
      await fulfill(requests[3], 95)
      await page.waitForTimeout(50)
      assert.equal(await page.getByRole("progressbar").count(), 0, "old reads cannot restore disconnected quotas")
      if (boundary === "native-disconnect" || boundary === "transport-disconnect") {
        assert.equal(requests.length, 4, "obsolete trailing demand is fenced on disconnect")
        await page.evaluate(boundary => {
          if (boundary === "native-disconnect") (window as any).usageFixture.connection("connected")
          else (window as any).usageFixture.transport("connected")
        }, boundary)
      }
      await waitRequests(requests, 5)
      await fulfill(requests[4], 30)
      await page.getByRole("progressbar").waitFor()
      assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "30")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("provider catalogue bursts refresh in place, coalesce reads and ignore other native locations", async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 400 }, locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    const bar = page.getByRole("progressbar")
    await bar.waitFor()
    const original = await bar.elementHandle()
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated", "first", "/another-location"))
    await page.waitForTimeout(50)
    assert.equal(requests.length, 1, "another location's catalogue is not this quota's authority")
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) (window as any).usageFixture.event("provider.updated")
    })
    await waitRequests(requests, 2)
    assert.equal(await original!.evaluate(el => el.isConnected), true, "passive events must not replace quota with Loading")
    if (process.env.CODENOMAD_USAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_USAGE_CAPTURE })
    await fulfill(requests[1], 20)
    await waitRequests(requests, 3)
    assert.equal(await bar.getAttribute("aria-valuenow"), "20")
    assert.equal(await original!.evaluate(el => el.isConnected), true, "quota updates keep the same bar DOM")
    await fulfill(requests[2], 30)
    await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "30")
    assert.equal(await original!.evaluate(el => el.isConnected), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("an account boundary during passive refresh clears quota and fences old and trailing results", async () => {
  const page = await browser.newPage()
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) (window as any).usageFixture.event("provider.updated")
    })
    await waitRequests(requests, 2)
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched"))
    await waitRequests(requests, 3)
    assert.equal(await page.getByRole("progressbar").count(), 0)
    await fulfill(requests[1], 90)
    await page.waitForTimeout(50)
    assert.equal(requests.length, 3, "obsolete passive demand must not restart an old account read")
    assert.equal(await page.getByRole("progressbar").count(), 0)
    await fulfill(requests[2], 40)
    await page.getByRole("progressbar").waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "40")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("stable window labels handle removed quotas and passive read failure without retaining old data", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.getByRole("progressbar").waitFor()
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 2)
    await requests[1].fulfill({ contentType: "application/json", body: JSON.stringify({
      requestedProviderId: "openai", providerId: "codex", providerName: "Codex", supported: true, configured: true,
      ok: true, fetchedAt: Date.now(), windows: { weekly: { usedPercent: 30, remainingPercent: 70, resetAt: null, windowSeconds: 604800 } },
    }) })
    await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "30", undefined, { timeout: 5000 })
      .catch(async error => { console.error("Window replacement failure", errors, await page.locator("body").innerText()); throw error })
    assert.equal(await page.getByRole("progressbar").count(), 1)
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 3)
    await requests[2].fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) })
    await page.getByText("Usage is temporarily unavailable.", { exact: true }).waitFor({ timeout: 5000 })
      .catch(async error => { console.error("Failure display", errors, await page.locator("body").innerText(), requests.length); throw error })
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Claude Code sessions label model-scoped limits beside the plan windows", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await page.evaluate(() => (window as any).usageFixture.select({ providerId: "claude-code", modelId: "claude-opus-5-5" }))
    await waitRequests(requests, 2)
    assert.equal(new URL(requests[1].request().url()).pathname, "/api/usage/claude-code")
    const quota = (usedPercent: number, windowSeconds: number) => ({ usedPercent, remainingPercent: 100 - usedPercent, windowSeconds, resetAt: null })
    await requests[1].fulfill({ contentType: "application/json", body: JSON.stringify({
      requestedProviderId: "claude-code", providerId: "claude-code", providerName: "Claude", supported: true, configured: true, ok: true,
      fetchedAt: Date.now(), windows: { "5h": quota(4, 18000), "7d": quota(1, 604800), "7d:Opus": quota(60, 604800) },
    }) })
    await page.getByText("7 days · Opus", { exact: true }).waitFor({ timeout: 5000 })
    assert.equal(await page.getByRole("progressbar").count(), 3)
    for (const label of ["5 hours", "7 days"]) assert.equal(await page.getByText(label, { exact: true }).count(), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, labels, fiveHours, weekly, used] of [
  ["en-US", ["Requests", "Tokens", "Input tokens", "Output tokens", "Usage"], "5 hours", "Weekly", "25% used"],
  ["fr-FR", ["Requêtes", "Tokens", "Tokens d’entrée", "Tokens de sortie", "Utilisation"], "5 heures", "Hebdomadaire", "25 % utilisé"],
] as const) test(`Google quota window labels preserve model names and used percentages (${locale})`, async () => {
  const page = await browser.newPage({ locale })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await page.evaluate(() => (window as any).usageFixture.select({ providerId: "google", modelId: "gemini-2.5-pro" }))
    await waitRequests(requests, 2)
    const request = new URL(requests[1].request().url())
    assert.equal(request.pathname, "/api/usage/google")
    assert.equal(request.searchParams.get("modelId"), "gemini-2.5-pro")
    const quota = { usedPercent: 25, remainingPercent: 75, resetAt: null, windowSeconds: null }
    const response = { requestedProviderId: "google", providerId: "google", supported: true, configured: true, ok: true, fetchedAt: Date.now() }
    await requests[1].fulfill({ json: { ...response, providerName: "Gemini CLI", windows: Object.fromEntries(
      ["requests", "tokens", "input_tokens", "output_tokens", "usage"].map(key => [`${key}:gemini-2.5-pro`, quota]),
    ) } })
    for (const label of labels) await page.getByText(`${label} · gemini-2.5-pro`, { exact: true }).waitFor({ timeout: 5000 })
    assert.equal(await page.getByRole("progressbar").count(), 5)
    assert.deepEqual(await page.getByRole("progressbar").evaluateAll(bars => bars.map(bar => bar.getAttribute("aria-valuenow"))), Array(5).fill("25"))
    assert.equal(await page.getByText(used, { exact: true }).count(), 5)

    // Antigravity shares the Google provider and emits plan/family-scoped windows.
    await page.evaluate(() => (window as any).usageFixture.event("credential.switched"))
    await waitRequests(requests, 3)
    await requests[2].fulfill({ json: { ...response, providerName: "Antigravity", windows: {
      "5h": { ...quota, windowSeconds: 18000 }, "weekly:Claude/GPT": { ...quota, windowSeconds: 604800 },
    } } })
    await page.getByText(fiveHours, { exact: true }).waitFor()
    await page.getByText(`${weekly} · Claude/GPT`, { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").count(), 2)
    assert.equal(await page.getByText(used, { exact: true }).count(), 2)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

const consoleUsage = (console: OpenCodeConsoleUsage) => ({
  requestedProviderId: "opencode", providerId: "opencode-console", providerName: "OpenCode Console",
  supported: true, configured: true, ok: true, fetchedAt: Date.now(), windows: {}, console,
})
const emptyConsole = (): OpenCodeConsoleUsage => ({ requests: { "24h": 0, "7d": 0, "30d": 0 }, models: [], budgets: { status: "available", items: [] } })

test("Console counters render without gauges, model homonyms retain providers, budgets distinguish empty/unavailable/items", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 320, height: 750 } })
  try {
    const { requests, errors } = await prepare(page)
    await page.getByText("Loading usage…", { exact: true }).waitFor()
    await waitRequests(requests, 1)
    await requests[0].fulfill({ json: consoleUsage(emptyConsole()) })
    await page.getByText("No requests in the last 30 days.", { exact: true }).waitFor()
    assert.deepEqual(await page.locator("dd").allTextContents(), ["0", "0", "0"])
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.equal(await page.getByText("Service account budgets", { exact: true }).count(), 0)
    const info = page.getByRole("button", { name: "Requests", exact: true })
    await info.focus(); await page.keyboard.press("Enter")
    await page.getByText(/Counts cover the connected OpenCode Console account/).waitFor()
    await page.keyboard.press("Escape")
    const usage = emptyConsole()
    usage.requests = { "24h": 1234, "7d": 5678, "30d": 9012 }
    usage.models = [{ model: "same-model", provider: "provider-a", requests: 1000 }, { model: "same-model", provider: "provider-b", requests: 2000 },
      { model: "a".repeat(150), provider: "p".repeat(150), requests: 12 }]
    usage.budgets.status = "unavailable"
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 2); await requests[1].fulfill({ json: consoleUsage(usage) })
    await page.getByRole("table").waitFor()
    assert.equal(await page.getByRole("columnheader").count(), 3)
    assert.equal(await page.getByRole("columnheader", { name: "Requests", exact: true }).evaluate(el => getComputedStyle(el).textAlign), "end")
    assert.equal(await page.getByRole("row").count(), 4)
    assert.equal(await page.getByRole("cell", { name: "same-model", exact: true }).count(), 2)
    await page.getByText("Budgets unavailable.", { exact: true }).waitFor()
    assert.deepEqual(await page.locator("dd").allTextContents(), ["1,234", "5,678", "9,012"])
    usage.budgets = { status: "available", items: [{ name: "A long service account ".repeat(10), id: "sa_123", spentUsd: 1.25, limitUsd: 10, resetAt: Date.UTC(2026, 11, 1) }] }
    await page.evaluate(() => (window as any).usageFixture.event("provider.updated"))
    await waitRequests(requests, 3); await requests[2].fulfill({ json: consoleUsage(usage) })
    await page.getByText("$1.25 / $10.00", { exact: true }).waitFor()
    assert.equal(await page.getByText("Budgets unavailable.", { exact: true }).count(), 0)
    await page.getByText(/Resets /).waitFor()
    assert.equal(await page.locator("li bdi").nth(1).textContent(), "sa_123")
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    if (process.env.CODENOMAD_USAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_USAGE_CAPTURE.replace(/\.png$/, "-console.png") })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [reason, message, link] of [
  ["missing-credential", "Connect OpenCode Console to view usage.", true],
  ["access-denied", "Console access denied. Check your OpenCode Console connection.", true],
  ["invalid-credential", "OpenCode Console credential is invalid or expired.", true],
  ["invalid-response", "Invalid Console usage response.", false],
  ["network-error", "Cannot reach OpenCode Console.", false],
] as const) test(`Console error ${reason} is localized and offers only relevant connection navigation`, async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await requests[0].fulfill({ json: { ...consoleUsage(emptyConsole()), console: undefined, ok: false,
      configured: reason !== "missing-credential", unavailableReason: `opencode-console-${reason}` } })
    await page.getByRole("status").getByText(message, { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Settings → Providers", exact: true }).count(), link ? 1 : 0)
    if (link) {
      await page.getByRole("button", { name: "Settings → Providers", exact: true }).click()
      assert.deepEqual(await page.evaluate(() => (window as any).usageFixture.settings()), { open: true, section: "providers" })
    }
    assert.equal(await page.getByRole("progressbar").count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const [locale, message] of [
  ["en", "Cannot reach OpenCode Console."],
  ["fr", "Impossible de joindre OpenCode Console."],
] as const) test(`Console timeout message follows the app locale (${locale})`, async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await page.evaluate(locale => (window as any).usageFixture.locale(locale), locale)
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale)
    await waitRequests(requests, 1)
    await requests[0].fulfill({ json: { ...consoleUsage(emptyConsole()), console: undefined, ok: false,
      unavailableReason: "opencode-console-network-error" } })
    await page.getByText(message, { exact: true }).waitFor()
    assert.equal(await page.getByText("Usage is temporarily unavailable.", { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const locale of ["en", "fr"] as const) test(`largest safe Console counts stay inside a 300px card (${locale})`, async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 300, height: 750 } })
  try {
    const { requests, errors } = await prepare(page)
    await page.evaluate(locale => {
      (window as any).usageFixture.locale(locale)
      document.querySelector("[data-usage]")!.className = "border border-base bg-surface-secondary px-3 py-2"
    }, locale)
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale)
    await waitRequests(requests, 1)
    const usage = emptyConsole()
    usage.requests = { "24h": Number.MAX_SAFE_INTEGER, "7d": Number.MAX_SAFE_INTEGER, "30d": Number.MAX_SAFE_INTEGER }
    usage.models = [{ model: "paid-model", provider: "opencode", requests: Number.MAX_SAFE_INTEGER }]
    await requests[0].fulfill({ json: consoleUsage(usage) })
    await page.getByRole("table").waitFor()
    const expected = await page.evaluate(locale => new Intl.NumberFormat(locale).format(Number.MAX_SAFE_INTEGER), locale)
    assert.deepEqual(await page.locator("dd").allTextContents(), [expected, expected, expected])
    assert.equal(await page.getByRole("cell").last().textContent(), expected)
    const overflow = await page.locator("[data-usage]").evaluate(card => {
      const bounds = card.getBoundingClientRect()
      return Array.from(card.querySelectorAll("*")).filter(element => {
        const rect = element.getBoundingClientRect()
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || element.scrollWidth > element.clientWidth + 1
      }).map(element => element.tagName)
    })
    assert.deepEqual(overflow, [], "all elements and their text must fit inside the card")
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const colorScheme of ["light", "dark"] as const) test(`Console error text and action meet AA contrast (${colorScheme})`, async () => {
  const page = await browser.newPage({ locale: "en-US", colorScheme, viewport: { width: 300, height: 200 } })
  try {
    await page.addInitScript("window.__name = f => f")
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1)
    await requests[0].fulfill({ json: { ...consoleUsage(emptyConsole()), console: undefined, ok: false,
      unavailableReason: "opencode-console-access-denied" } })
    const message = page.getByText("Console access denied. Check your OpenCode Console connection.", { exact: true })
    const action = page.getByRole("button", { name: "Settings → Providers", exact: true })
    await message.waitFor()
    for (const [name, target] of [["message", message], ["action", action]] as const) {
      const ratio = await target.evaluate(element => {
        const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!
        const rgba = (color: string) => {
          ctx.clearRect(0, 0, 1, 1)
          ctx.fillStyle = color
          ctx.fillRect(0, 0, 1, 1)
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
          return [r, g, b, a / 255]
        }
        const over = (front: number[], back: number[]) => {
          const alpha = front[3] + back[3] * (1 - front[3])
          return [...front.slice(0, 3).map((value, i) => alpha ? (value * front[3] + back[i] * back[3] * (1 - front[3])) / alpha : 0), alpha]
        }
        let foreground = rgba(getComputedStyle(element).color), background = [0, 0, 0, 0]
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node)
          if (style.backgroundImage !== "none") throw new Error("Contrast sampling requires solid backgrounds")
          const fill = rgba(style.backgroundColor)
          foreground = over(foreground, fill)
          background = over(background, fill)
          foreground[3] *= Number(style.opacity)
          background[3] *= Number(style.opacity)
        }
        const luminance = (color: number[]) => {
          const [r, g, b] = over(color, [255, 255, 255, 1]).slice(0, 3).map(value => {
            const c = value / 255
            return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4
          })
          return .2126 * r + .7152 * g + .0722 * b
        }
        const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
        return (light + .05) / (dark + .05)
      })
      console.log(`${colorScheme} Console ${name} contrast: ${ratio.toFixed(2)}:1`)
      assert.ok(ratio >= 4.5, `${colorScheme} ${name} contrast ${ratio.toFixed(2)}:1`)
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    if (process.env.CODENOMAD_USAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_USAGE_CAPTURE.replace(/\.png$/, `-error-${colorScheme}.png`) })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("French app locale formats Console numbers, USD and dates despite English browser locale", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    const { requests, errors } = await prepare(page)
    await page.evaluate(() => (window as any).usageFixture.locale("fr"))
    await page.waitForFunction(() => document.documentElement.lang === "fr")
    await waitRequests(requests, 1)
    const usage = emptyConsole()
    usage.requests["24h"] = 1234
    const resetAt = Date.UTC(2026, 10, 6)
    usage.budgets.items = [{ name: "Budget", id: "sa_123", spentUsd: 1234.5, limitUsd: 5000, resetAt }]
    await requests[0].fulfill({ json: consoleUsage(usage) })
    await page.getByText("Aujourd’hui (UTC)", { exact: true }).waitFor()
    const formatted = await page.evaluate(resetAt => ({ number: new Intl.NumberFormat("fr").format(1234),
      usd: new Intl.NumberFormat("fr", { style: "currency", currency: "USD" }).format(1234.5),
      date: new Date(resetAt).toLocaleString("fr", { dateStyle: "short", timeStyle: "short" }) }), resetAt)
    assert.equal(await page.locator("dd").first().textContent(), formatted.number)
    assert.ok((await page.locator("body").textContent())?.includes(formatted.usd))
    assert.ok((await page.locator("body").textContent())?.includes(formatted.date))
    await page.evaluate(() => (window as any).usageFixture.select({ providerId: "opencode", modelId: "big-pickle" }))
    await waitRequests(requests, 2)
    await requests[1].fulfill({ json: { ...consoleUsage(emptyConsole()), console: undefined, providerId: "opencode-free", providerName: "OpenCode Console",
      estimated: true, freeEstimate: { requests: 1234, reference: 2000, exhausted: true },
      windows: { daily: { usedPercent: 61.7, remainingPercent: 38.3, resetAt: Date.now() + 86400000, windowSeconds: 86400, valueLabel: "1234 / 2000" } } } })
    await page.getByText("Épuisé", { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "100")
    const expectedFree = await page.evaluate(() => `${new Intl.NumberFormat("fr").format(1234)} / ${new Intl.NumberFormat("fr").format(2000)}`)
    assert.ok((await page.locator("body").textContent())?.includes(expectedFree))
    await page.getByText("OpenCode Console", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("free quota events coalesce; exhaustion remains textual with unknown count and expires at UTC midnight", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 320, height: 350 } })
  try {
    const midnight = Date.UTC(2026, 10, 7)
    await page.clock.install({ time: midnight - 1000 })
    await page.clock.pauseAt(midnight - 1000)
    const { requests, errors } = await prepare(page)
    await waitRequests(requests, 1); await fulfill(requests[0], 10)
    await page.evaluate(() => (window as any).usageFixture.select({ providerId: "opencode", modelId: "big-pickle" }))
    await waitRequests(requests, 2)
    const free = (exhausted: boolean, resetAt: number, count: number | null = null) => ({
      requestedProviderId: "opencode", providerId: "opencode-free", providerName: "OpenCode", supported: true, configured: true,
      ok: true, estimated: true, fetchedAt: midnight - 1000, freeEstimate: { requests: count, reference: 200, exhausted },
      windows: { daily: { usedPercent: exhausted ? 100 : 0, remainingPercent: exhausted ? 0 : 100, resetAt, windowSeconds: 86400 } },
    })
    await requests[1].fulfill({ json: free(true, midnight) })
    await page.getByText("Exhausted", { exact: true }).waitFor()
    await page.getByText("Estimated", { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "100")
    assert.equal(await page.getByText("200 / 200", { exact: true }).count(), 0)
    assert.equal(await page.getByText("--", { exact: true }).count(), 1)
    const info = page.getByRole("button", { name: "Estimated", exact: true })
    await info.focus(); await page.keyboard.press("Enter")
    await page.getByText(/Exhaustion clears at 00:00 UTC/).waitFor()
    await page.keyboard.press("Escape")
    if (process.env.CODENOMAD_USAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_USAGE_CAPTURE.replace(/\.png$/, "-exhausted.png") })
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) (window as any).usageFixture.event("session.step.failed", "first", "/repo", { error: { type: "provider.quota" } })
    })
    await waitRequests(requests, 3)
    await page.clock.runFor(1000)
    assert.equal(await page.getByText("Exhausted", { exact: true }).count(), 0, "midnight clears the mark before HTTP settles")
    assert.equal(requests.length, 3, "midnight shares the active read")
    await requests[2].fulfill({ json: free(true, midnight) })
    await waitRequests(requests, 4)
    assert.equal(await page.getByText("Exhausted", { exact: true }).count(), 0)
    await requests[3].fulfill({ json: free(false, midnight + 86400000, 0) })
    await page.getByText("0 / 200", { exact: true }).waitFor()
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "0")
    await page.evaluate(() => (window as any).usageFixture.active(false))
    await page.evaluate(() => (window as any).usageFixture.event("session.step.failed", "first", "/repo", { error: { type: "provider.quota" } }))
    await page.clock.fastForward(86400000)
    assert.equal(requests.length, 4, "hidden panel neither polls nor reads at midnight")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
