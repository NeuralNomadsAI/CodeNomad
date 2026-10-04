import type { ViteDevServer } from "vite"

const ENTRY = "/tests/browser/fixtures/interruption-dock.tsx"
const PREPARATION_TIMEOUT_MS = 30_000

/** Compile the fixture's static graph, not a hidden browser visit. Keep the
 * installed Solid export/compiler and excluded icon barrel exactly as-is. */
export async function prepareInterruptionDock(server: ViteDevServer): Promise<void> {
  const started = performance.now()
  const logger = server.config.logger
  const originalError = logger.error
  const errors: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  logger.error = (message, options) => {
    errors.push(message)
    originalError.call(logger, message, options)
  }
  try {
    await Promise.race([
      (async () => {
        if (!await server.transformRequest(ENTRY)) throw new Error("Interruption fixture did not transform")
        // Vite's supported crawl completion API waits for transitive static
        // pre-transforms. It does not execute the fixture or its native events.
        await server.waitForRequestsIdle()
        if (errors.length) throw new Error(`Interruption fixture preparation failed: ${errors.join("\n")}`)
        const modules = [...server.moduleGraph.idToModuleMap.values()]
        const icon = modules.find(module => module.id?.replace(/\\/g, "/").split("?")[0]
          .endsWith("/lucide-solid/dist/source/Icon.jsx"))
        const compiled = icon?.transformResult?.code
        if (!compiled?.includes("_$template(`<svg>") || !compiled.includes("createComponent") || !compiled.includes("splitProps")) {
          throw new Error("Installed lucide Icon was not compiled by Solid")
        }
        const durationMs = Math.round(performance.now() - started)
        if (performance.now() - started >= PREPARATION_TIMEOUT_MS) throw new Error("Interruption fixture preparation deadline expired")
        console.log(JSON.stringify({ kind: "interruption-fixture-prepared", entry: ENTRY,
          durationMs, budgetMs: PREPARATION_TIMEOUT_MS,
          cacheDir: server.config.cacheDir, modules: modules.length,
          transformed: modules.filter(module => module.transformResult).length, solidIcon: icon!.id }))
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Interruption fixture preparation exceeded ${PREPARATION_TIMEOUT_MS}ms`)), PREPARATION_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
    logger.error = originalError
  }
}
