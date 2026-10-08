import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

export async function startDeviceUploadFixture() {
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "device-upload-fixture", configureServer(s) {
      s.middlewares.use("/device-upload-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/device-upload-fixture", '<html><body><div id="root" style="display:flex;height:700px;width:1000px"></div><script type="module" src="/tests/browser/fixtures/device-upload.tsx"></script></body></html>'))
      })
      s.middlewares.use("/api", (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end("{}") })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  return { server, url: `http://127.0.0.1:${server.httpServer.address().port}/device-upload-fixture` }
}
