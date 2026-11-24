import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "../fixture-cache.ts"
import { createFixtureShutdown } from "../fixture-shutdown.ts"

export async function startDeviceUploadFixture() {
  const cache = await createFixtureCache()
  const shutdown = createFixtureShutdown(cache)
  const events = { opened: 0 }
  let server
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../../..", import.meta.url)), logLevel: "error",
      cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "device-upload-fixture", configureServer(s) {
        s.middlewares.use("/api/events", (req, res) => {
          events.opened++
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
          res.write(": isolated device-upload events\n\n")
          req.once("close", () => res.end())
        })
        s.middlewares.use("/device-upload-fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/device-upload-fixture", '<html><body><div id="root" style="display:flex;height:700px;width:1000px"></div><script type="module" src="/tests/browser/fixtures/device-upload.tsx"></script></body></html>'))
        })
        s.middlewares.use("/api", (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end("{}") })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    return { server, events, url: `http://127.0.0.1:${server.httpServer.address().port}/device-upload-fixture` }
  } catch (error) {
    try {
      if (server) await server.close()
      else await cache.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Device upload fixture setup and cleanup failed")
    }
    throw error
  }
}
