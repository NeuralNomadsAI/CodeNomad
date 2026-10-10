import { version, type Plugin, type ViteDevServer } from "vite"

interface OwnedCache { cacheDir: string; dispose(): Promise<void> }

/** Vite 5's optimized load waits on info.processing, which optimizer.close
 * doesn't always settle. Cancel ONLY this cache's read-only load hook before
 * the container tracks its returned promise; never resolve native metadata.
 * The optimizer itself still has to acknowledge both native close passes. */
export function createFixtureShutdown(cache: OwnedCache) {
  const waiting = new Set<() => void>()
  const contexts = new Set<Promise<void>>()
  let createdContexts = 0, disposedContexts = 0
  let stopped = false, cancelled = 0
  const error = Object.assign(new Error("Owned fixture optimized load cancelled"), { code: "ERR_CLOSED_SERVER" })
  const plugin: Plugin = {
    name: "owned-fixture-optimized-load-cancellation",
    configResolved(config) {
      if (!version.startsWith("5.")) throw new Error("Fixture shutdown requires reviewed Vite 5 load lifecycle")
      const native = config.plugins.find(item => item.name === "vite:optimized-deps")
      if (typeof native?.load !== "function") throw new Error("Unsupported Vite optimized dependency load hook")
      const load = native.load
      // native optimizer.close awaits cancel, not every context's disposal.
      // In particular onCrawlEnd may hold an optimizationResult locally, out
      // of close's reach. Track its actual native context terminal callback.
      config.optimizeDeps.esbuildOptions = { ...config.optimizeDeps.esbuildOptions, plugins: [
        ...(config.optimizeDeps.esbuildOptions?.plugins ?? []), {
          name: "owned-fixture-optimizer-disposal",
          setup(build) {
            createdContexts++
            let done!: () => void
            const disposed = new Promise<void>(resolve => { done = resolve })
            contexts.add(disposed)
            build.onDispose(() => { disposedContexts++; contexts.delete(disposed); done() })
          },
        },
      ] }
      const prefix = `${config.cacheDir.replace(/\\/g, "/")}/deps/`
      native.load = function (...args) {
        if (!args[0].replace(/\\/g, "/").startsWith(prefix)) return load.apply(this, args)
        if (stopped) return Promise.reject(error)
        let cancel!: () => void
        const aborted = new Promise<never>((_, reject) => { cancel = () => { cancelled++; reject(error) } })
        waiting.add(cancel)
        return Promise.race([Promise.resolve().then(() => load.apply(this, args)), aborted])
          .finally(() => waiting.delete(cancel))
      }
    },
  }
  return {
    plugin,
    own(server: ViteDevServer) {
      const nativeClose = server.close.bind(server)
      let closing: Promise<void> | undefined
      server.close = () => closing ??= (async () => {
        stopped = true
        for (const cancel of waiting) cancel()
        // Pass two also cancels a late optimizer run started as pass one's
        // scan finishes. Neither a timer nor cancellation counts permits rm.
        await nativeClose()
        await nativeClose()
        const contextsAfterNativeClose = contexts.size
        await Promise.all([...contexts])
        const pending = (server as ViteDevServer & { _pendingRequests: Map<unknown, unknown> })._pendingRequests.size
        if (pending || waiting.size || contexts.size || createdContexts !== disposedContexts || server.httpServer?.listening) {
          throw new Error("Fixture server did not drain; cache retained")
        }
        await cache.dispose()
        console.log(JSON.stringify({ kind: "fixture-shutdown", cacheDir: cache.cacheDir,
          nativeClosePasses: 2, pending, cancelled, waiting: waiting.size, listening: false,
          createdContexts, disposedContexts, activeContexts: contexts.size, contextsAfterNativeClose }))
      })()
    },
  }
}
