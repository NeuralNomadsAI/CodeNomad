import type { Browser, BrowserContext } from "playwright"

/** Parallel fixture cold starts and settle waits can exceed Playwright's
 * default 30 s timeouts while several Vite servers and Chromium instances
 * share the runner's CPUs (in a four-wide CI run 199 tests legitimately ran
 * past 30 s). Arm a fixture browser (or persistent context) so every page
 * and context it later creates waits up to `timeout` ms for both navigation
 * and actions instead; idempotent. */
export function armFixtureNavigationBudget(browser: Browser | BrowserContext, timeout = 120_000): void {
  const marker = Symbol.for("codenomad.fixtureNavigationBudget")
  if ((browser as unknown as Record<symbol, boolean>)[marker]) return
  ;(browser as unknown as Record<symbol, boolean>)[marker] = true
  const newPage = browser.newPage.bind(browser)
  browser.newPage = async (options?: Parameters<BrowserContext["newPage"]>[0]) => {
    const page = await newPage(options)
    page.setDefaultNavigationTimeout(timeout)
    page.setDefaultTimeout(timeout)
    return page
  }
  if ("newContext" in browser) {
    const newContext = (browser as Browser).newContext.bind(browser)
    ;(browser as Browser).newContext = async (options?: Parameters<Browser["newContext"]>[0]) => {
      const context = await newContext(options)
      context.setDefaultNavigationTimeout(timeout)
      context.setDefaultTimeout(timeout)
      return context
    }
  }
}
