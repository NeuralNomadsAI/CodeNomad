import { createHash, randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "../fixture-cache"
import { createFixtureShutdown } from "../fixture-shutdown"

/** A fixture registration is fully declarative: verbatim route HTML, exactly
 * what today's per-file middlewares pass to transformIndexHtml. */
export interface FixtureRoute { path: string, html: string }
export interface FixtureDefinition { name: string, routes: FixtureRoute[] }
export type ControlHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>

export interface FixtureDaemon {
  readonly port: number
  readonly baseUrl: string
  readonly secret: string
  readonly stats: { transforms: number }
  register(definition: FixtureDefinition): Promise<string>
  installControl(handler: ControlHandler): void
  warmup(definition: FixtureDefinition): Promise<void>
  close(): Promise<void>
}

export async function startFixtureDaemon({ directory, cacheDir, readyFile }: {
  directory: string, cacheDir?: string, readyFile?: string
}): Promise<FixtureDaemon> {
  const owned = cacheDir ? { cacheDir, dispose: async () => {} } : await createFixtureCache()
  const shutdown = createFixtureShutdown(owned)
  const stats = { transforms: 0 }
  const urls = new Map<string, string>()
  const fingerprints = new Map<string, string>()
  const routes = new Map<string, FixtureRoute>()
  const controls: ControlHandler[] = []

  // The dispatcher must be installed through configureServer so it runs ahead
  // of Vite's internal stack, exactly like today's per-file fixture plugins;
  // registrations only mutate the route table afterwards.
  const server: ViteDevServer = await createServer({
    configFile: false, root: directory, logLevel: "error",
    cacheDir: owned.cacheDir,
    plugins: [
      shutdown.plugin,
      { name: "fixture-daemon-transform-stats", transform() { stats.transforms++; return undefined } },
      solid(),
      {
        name: "fixture-daemon-routes",
        configureServer(s) {
          s.middlewares.use(async (request, response, next) => {
            for (const control of controls) if (await control(request, response)) return
            const route = routes.get(request.url?.split("?")[0] ?? "")
            if (!route) return next()
            try {
              response.setHeader("Content-Type", "text/html")
              response.end(await s.transformIndexHtml(route.path, route.html))
            } catch (error) { response.statusCode = 500; response.end(String(error)) }
          })
        },
      },
    ],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  const port = (server.httpServer!.address() as { port: number }).port
  const baseUrl = `http://127.0.0.1:${port}`
  const secret = randomBytes(16).toString("hex")
  if (readyFile) await writeFile(readyFile, JSON.stringify({ port, pid: process.pid, secret, startedAt: Date.now() }))

  return {
    port, baseUrl, secret, stats,
    async register(definition) {
      if (!/^[\w-]+$/.test(definition.name) || !definition.routes?.length) throw new Error("invalid fixture definition")
      const fingerprint = createHash("sha256").update(JSON.stringify(definition)).digest("hex")
      const known = fingerprints.get(definition.name)
      if (known) {
        if (known !== fingerprint) throw new Error(`fixture ${definition.name} already registered with a different payload`)
        return urls.get(definition.name)!
      }
      for (const route of definition.routes) {
        if (routes.has(route.path)) throw new Error(`fixture route already registered: ${route.path}`)
        routes.set(route.path, route)
      }
      const url = `${baseUrl}${definition.routes[0].path}`
      fingerprints.set(definition.name, fingerprint)
      urls.set(definition.name, url)
      return url
    },
    installControl(handler) { controls.push(handler) },
    // Browser-driven warmup: a real page load is the only honest way to drive
    // Vite's lazy dependency discovery and optimizer to settle — direct
    // transformRequest calls cancel in-flight esbuild builds instead.
    async warmup(definition) {
      const url = await this.register({ name: "__warmup", ...definition })
      const { chromium } = await import("playwright")
      const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
      try {
        const page = await browser.newPage()
        await page.goto(url, { waitUntil: "load" })
      } finally { await browser.close() }
    },
    close: () => server.close(),
  }
}
