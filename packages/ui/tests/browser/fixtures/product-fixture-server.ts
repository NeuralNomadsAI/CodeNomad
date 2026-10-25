import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "../fixture-navigation-budget"
import { chromium } from "playwright"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "../fixture-cache"
import { createFixtureShutdown } from "../fixture-shutdown"

export async function startProductFixture(name: string) {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    server = await createServer({ configFile: false, cacheDir: cache.cacheDir, root: fileURLToPath(new URL("../../..", import.meta.url)), logLevel: "error",
      plugins: [shutdown.plugin, solid(), { name: "product-fixture", configureServer(s) { s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", `<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/${name}.tsx"></script></body></html>`))
      }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
    shutdown.own(server)
    await server.listen()
    const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
    return { browser, url: `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`,
      close: async () => { try { await browser.close() } finally { await server!.close() } } }
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
}
