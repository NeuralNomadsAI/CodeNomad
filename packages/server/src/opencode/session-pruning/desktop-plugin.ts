import plugin from "./plugin"
import { followPresence } from "./presence"

// The bundled factory is wrapped by a tiny auto-discovered native entry.
// No tools, commands or model hooks are registered, even while CodeNomad is open.
export function desktopPlugin(presenceDirectory: string) {
  return {
    ...plugin,
    setup: (ctx: Parameters<typeof plugin.setup>[0]) => followPresence(presenceDirectory, async () => {
      const cleanup = await plugin.setup(ctx)
      return async () => { await cleanup?.() }
    }),
  }
}
