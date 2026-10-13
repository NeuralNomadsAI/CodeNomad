// Interactive design fixture using the production Git panel and central reader.
// Synthetic data only; does not connect to OpenCode or mutate a repository.
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { prepareGitPrototypeAssets } from "../packages/ui/tests/browser/fixtures/git-history-assets.mjs"

prepareGitPrototypeAssets()

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../packages/ui/", import.meta.url)),
  publicDir: fileURLToPath(new URL("../packages/ui/src/renderer/public", import.meta.url)),
  plugins: [solid(), {
    name: "git-history-prototype",
    configureServer(server) {
      server.middlewares.use("/fixture", async (_request, response) => {
        response.setHeader("Content-Type", "text/html")
        response.end(await server.transformIndexHtml("/fixture", '<html><head><title>CodeNomad · Files prototype</title></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/git-history.tsx"></script></body></html>'))
      })
    },
  }],
  resolve: { dedupe: ["solid-js"] },
  optimizeDeps: { exclude: ["lucide-solid"] },
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
})
await server.listen()
console.log(`Git prototype: http://127.0.0.1:${server.httpServer.address().port}/fixture`)
for (const event of ["SIGINT", "SIGTERM"]) process.on(event, () => { void server.close().then(() => process.exit()) })
