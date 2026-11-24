import { fileURLToPath } from "node:url"
import type { Browser, Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import { observeHeaderFixture } from "./header-fixture-diagnostics"

const secondary = (phase: string, error: unknown) => console.error("session-aside-harness", phase, String(error).slice(0, 256))

export async function startSessionAsideFixture() {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  let server: ViteDevServer | undefined, ready = false
  return runWithDiagnosticCleanup({
    run: async () => {
      server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
        cacheDir: cache.cacheDir,
        plugins: [shutdown.plugin, solid(), { name: "aside-fixture", configureServer(s) {
          s.middlewares.use("/aside-fixture", async (_req, res) => {
            res.setHeader("Content-Type", "text/html")
            res.end(await s.transformIndexHtml("/aside-fixture", '<html><body><div id="root" style="margin:24px;max-width:1100px"></div><script type="module" src="/tests/browser/fixtures/session-aside.tsx"></script></body></html>'))
          })
        } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
        server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
      })
      shutdown.own(server)
      await server.listen()
      const fixture = { server, url: `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/aside-fixture` }
      ready = true
      return fixture
    },
    diagnose: async () => {},
    cleanup: async () => {
      if (ready) return
      if (server) await server.close()
      else await cache.dispose()
    },
    onObservationError: error => secondary("startup observation", error),
    onCleanupError: error => secondary("startup cleanup", error),
  })
}

export async function closeSessionAsideHarness(browser?: Pick<Browser, "close">, server?: Pick<ViteDevServer, "close">) {
  await runWithDiagnosticCleanup({
    run: async () => { await browser?.close() },
    diagnose: async () => {},
    cleanup: async () => { await server?.close() },
    onObservationError: error => secondary("teardown observation", error),
    onCleanupError: error => secondary("teardown cleanup", error),
  })
}

export async function prepareSessionAsidePage<T>(page: Page, run: () => Promise<T>): Promise<T> {
  let observer: ReturnType<typeof observeHeaderFixture> | undefined, ready = false
  return runWithDiagnosticCleanup({
    run: async () => {
      observer = observeHeaderFixture(page)
      await observer.install()
      const result = await run()
      ready = true
      return result
    },
    diagnose: async () => { await observer?.diagnose(message => console.error("session-aside-setup", message)) },
    cleanup: async () => {
      try { observer?.detach() }
      finally { if (!ready) await page.close() }
    },
    onObservationError: error => secondary("page observation", error),
    onCleanupError: error => secondary("page cleanup", error),
  })
}
