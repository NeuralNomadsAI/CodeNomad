import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  const shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, cacheDir: cache.cacheDir, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [shutdown.plugin, solid(), { name: "provider-usage-fixture", configureServer(vite) {
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
  page.on("pageerror", error => errors.push(error.message))
  // Do not open any shared server/SSE connection. Events below use the real dispatcher.
  await page.addInitScript(() => {
    ;(window as any).EventSource = class {
      static OPEN = 1; readyState = 1
      addEventListener() {} removeEventListener() {} close() {}
    }
  })
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname.startsWith("/api/usage/")) { requests.push(route); return }
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

for (const [locale, usedTemplate, creditsTemplate, unlimited] of [
  ["en-US", "{used} / {limit} used", "{used} credits used", "Unlimited"],
  ["fr-FR", "{used} / {limit} utilisés", "{used} crédits utilisés", "Illimité"],
  ["de-DE", "{used} / {limit} verbraucht", "{used} Credits verbraucht", "Unbegrenzt"],
  ["es-ES", "{used} / {limit} usados", "{used} créditos usados", "Ilimitado"],
  ["he-IL", "{used} / {limit} נוצלו", "{used} נקודות זכות נוצלו", "ללא הגבלה"],
  ["ja-JP", "{used} / {limit} 使用済み", "{used} クレジット使用済み", "無制限"],
  ["ne-NP", "{used} / {limit} प्रयोग भयो", "{used} क्रेडिट प्रयोग भयो", "असीमित"],
  ["ru-RU", "{used} / {limit} использовано", "{used} кредитов использовано", "Без ограничений"],
  ["tr-TR", "{used} / {limit} kullanıldı", "{used} kredi kullanıldı", "Sınırsız"],
  ["zh-CN", "已使用 {used} / {limit}", "已使用 {used} 点数", "无限制"],
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
      completions: { ...quotaWindow, consumption: { unlimited: true } },
    } } })
    const formatted = await page.evaluate(locale => {
      const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 8 })
      return [25.75, 100, 1234.125].map(value => number.format(value))
    }, locale === "zh-CN" ? "zh-Hans" : locale)
    await page.getByText(usedTemplate.replace("{used}", formatted[0]).replace("{limit}", formatted[1]), { exact: true }).waitFor()
    await page.getByText(creditsTemplate.replace("{used}", formatted[2]), { exact: true }).waitFor()
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
      requestedProviderId: "opencode", providerId: "opencode-free", providerName: "OpenCode Zen",
      supported: true, configured: true, ok: true, estimated: true, fetchedAt: Date.now(),
      windows: { daily: { usedPercent: 21, remainingPercent: 79, windowSeconds: 86400, resetAt: Date.UTC(2026, 10, 4), valueLabel: "42 / 200" } },
    } })
    await page.getByText("42 / 200", { exact: true }).waitFor()
    await page.getByText("(estimation)").waitFor()
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
