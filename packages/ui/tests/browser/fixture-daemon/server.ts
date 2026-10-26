import { createHash, randomBytes } from "node:crypto"
import { rename, writeFile } from "node:fs/promises"
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
  readonly registeredCount: number
  /** The staleness baseline: source mtimes after this instant invalidate the daemon. */
  readonly startedAt: number
  register(definition: FixtureDefinition): Promise<string>
  installControl(handler: ControlHandler): void
  announce(readyFile: string): Promise<void>
  warmup(definition: FixtureDefinition): Promise<void>
  close(): Promise<void>
}

export async function startFixtureDaemon({ directory, cacheDir, readyFile, freshnessRoots }: {
  directory: string, cacheDir?: string, readyFile?: string, freshnessRoots?: string[]
}): Promise<FixtureDaemon> {
  // The staleness baseline predates every side effect below: any source edit
  // with an mtime after this instant invalidates the daemon for new borrowers.
  const startedAt = Date.now()
  // Vite's non-middleware dev server registers its own SIGTERM and stdin-end
  // handlers while createServer() runs — they close the server and then
  // hard-exit the process (code 0), racing every teardown this daemon
  // promises its callers. This daemon owns its process's lifecycle; drop
  // exactly the listeners Vite added, leaving whatever was registered
  // before intact.
  const signalListenersBefore = new Set(process.listeners("SIGTERM"))
  const stdinEndListenersBefore = new Set(process.stdin.listeners("end"))
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
  for (const listener of process.listeners("SIGTERM")) if (!signalListenersBefore.has(listener)) process.removeListener("SIGTERM", listener as (...args: unknown[]) => void)
  for (const listener of process.stdin.listeners("end")) if (!stdinEndListenersBefore.has(listener)) process.stdin.removeListener("end", listener as () => void)
  const port = (server.httpServer!.address() as { port: number }).port
  const baseUrl = `http://127.0.0.1:${port}`
  const secret = randomBytes(16).toString("hex")

  return {
    port, baseUrl, secret, stats, startedAt,
    get registeredCount() { return urls.size },
    async register(definition) {
      if (!/^[\w-]+$/.test(definition.name) || !definition.routes?.length) throw new Error("invalid fixture definition")
      if (freshnessRoots) {
        const { newestSourceMtime } = await import("./freshness")
        if (await newestSourceMtime(freshnessRoots) > startedAt) {
          throw Object.assign(new Error(`fixture daemon is stale: sources under ${freshnessRoots.join(",")} changed since start`), { code: "ERR_FIXTURE_DAEMON_STALE" })
        }
      }
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
    // The ready file carries the secret; write it atomically at 0600 so no
    // other local user can read it and no borrower ever parses a half file.
    async announce(target) {
      const staging = `${target}.staging`
      await writeFile(staging, JSON.stringify({ port, pid: process.pid, secret, startedAt }), { mode: 0o600 })
      await rename(staging, target)
    },
    // Browser-driven warmup: a real page load is the only honest way to drive
    // Vite's lazy dependency discovery and optimizer to settle — direct
    // transformRequest calls cancel in-flight esbuild builds instead.
    async warmup(definition) {
      const url = await this.register({ name: "__warmup", ...definition })
      const { chromium } = await import("playwright")
      const { armFixtureNavigationBudget } = await import("../fixture-navigation-budget")
      const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
      armFixtureNavigationBudget(browser)
      try {
        const page = await browser.newPage()
        await page.goto(url, { waitUntil: "load" })
      } finally { await browser.close() }
    },
    close: () => server.close(),
  }
}
