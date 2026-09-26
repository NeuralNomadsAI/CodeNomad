import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

export async function startProductFixture(name: string) {
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "product-fixture", configureServer(s) { s.middlewares.use("/fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html")
      res.end(await s.transformIndexHtml("/fixture", `<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/${name}.tsx"></script></body></html>`))
    }) } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  try {
    const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    return { browser, url: `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`,
      close: async () => { await browser.close(); await server.close() } }
  } catch (error) { await server.close(); throw error }
}
