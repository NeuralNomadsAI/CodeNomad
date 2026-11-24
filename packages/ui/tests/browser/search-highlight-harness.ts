import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, preview, createServer, type InlineConfig, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

export const baselineCommit = "6f6edbbcb91227fdd1d5863f6c21fad2691de679"

/** Same Solid components and styles; only the painting functions are swapped. */
export async function startHighlightHarness() {
  const root = fileURLToPath(new URL("../..", import.meta.url))
  const config: InlineConfig = { configFile: false, root, logLevel: "error",
    plugins: [{ name: "highlight-comparison", enforce: "pre",
      async transform(code, id) {
        if (id.replaceAll("\\", "/").endsWith("/src/components/message-block.tsx")) {
          const before = 'from "./search-highlights"'
          if (!code.includes(before)) throw new Error("Highlight comparison import seam changed")
          return code.replace(before, 'from "/tests/browser/fixtures/search-highlight-adapter.ts"')
        }
      },
      configureServer(s) {
        s.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/search-highlight.tsx"></script></body></html>'))
        })
      },
    }, solid()], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  }
  if (process.env.CODENOMAD_HIGHLIGHT_PRODUCTION) {
    const outDir = await mkdtemp(join(process.env.CODENOMAD_TEST_TEMP || tmpdir(), "highlight-build-"))
    await build({ ...config, build: { outDir, emptyOutDir: true, target: "esnext", manifest: true,
      rollupOptions: { input: join(root, "tests/browser/fixtures/search-highlight.tsx") } } })
    const manifest = JSON.parse(await readFile(join(outDir, ".vite/manifest.json"), "utf8"))
    const entry = Object.values(manifest).find((entry: any) => entry.isEntry) as { file: string; css?: string[] }
    await writeFile(join(outDir, "index.html"), `<html><head>${(entry.css ?? []).map(path => `<link rel="stylesheet" href="/${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="/${entry.file}"></script></body></html>`)
    const server = await preview({ configFile: false, root, logLevel: "error", build: { outDir }, preview: { host: "127.0.0.1", port: 0 } })
    return { server: { close: async () => {
      await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
      await rm(outDir, { recursive: true, force: true })
    } },
      url: `http://127.0.0.1:${(server.httpServer.address() as { port: number }).port}/fixture` }
  }
  // The default cacheDir is the shared (often junctioned) node_modules/.vite, whose
  // root-dependent hash lets concurrent checkouts evict these optimized deps mid-run.
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  let server: ViteDevServer | undefined
  try {
    server = await createServer({ ...config, cacheDir: cache.cacheDir, plugins: [shutdown.plugin, ...config.plugins!] })
    shutdown.own(server)
    await server.listen()
    return { server, url: `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture` }
  } catch (error) {
    try {
      if (server) await server.close()
      else await cache.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Highlight fixture setup and cleanup failed")
    }
    throw error
  }
}
