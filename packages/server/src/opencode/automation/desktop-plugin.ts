import type { Plugin } from "@opencode/plugin"
import { createDeveloperToolTransform } from "../automation-plugin"
import { followPresence } from "../desktop-plugin-presence"

// Definitions follow backend presence. Per-session routing remains authoritative.
export function desktopPlugin(presenceDirectory: string | readonly string[]): Plugin.Plugin {
  return {
    id: "codenomad.automation",
    setup: (ctx) => {
      // Keep inspected host identity across backend restart/presence reconciliation.
      // In-flight native tool snapshots may still finish their reconnect wait.
      const addDeveloperTools = createDeveloperToolTransform()
      return followPresence(presenceDirectory, async () => {
        const tools = await ctx.tool.transform((editor) => {
          addDeveloperTools(editor)
        })
        return async () => {
          await tools.dispose()
        }
      })
    },
  }
}
