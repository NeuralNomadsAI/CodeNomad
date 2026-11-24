import { armFixtureNavigationBudget } from "../fixture-navigation-budget"
import { borrowFixture } from "../fixture-borrow"
import { chromium } from "playwright"

/** Starts the product fixture for a named fixture page plus its browser. The
 * page itself is served by the shared fixture daemon; each caller keeps its
 * own armed browser. */
export async function startProductFixture(name: string) {
  const fixture = await borrowFixture({
    name: `product-${name}`,
    routes: [{ path: "/fixture", html: `<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/${name}.tsx"></script></body></html>` }],
  })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  return { browser, url: fixture.url, close: async () => { await browser.close() } }
}
