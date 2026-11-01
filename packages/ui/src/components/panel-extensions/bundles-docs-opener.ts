import { isIntegrationDocsUrl } from "../../../../server/src/panel-extensions/bundles-docs"
import type { bundlesDocsHostResultSchema } from "../../../../server/src/panel-extensions/bundles-contract"
import type { z } from "zod"
import { openExternalUrl } from "../../lib/external-url"
import { PanelExtensionBusyError } from "../../lib/panel-extensions-api"

type Resolution = z.infer<typeof bundlesDocsHostResultSchema>
/** One slot for this window, including resolution and any uncancellable native handoff. */
export function createBundlesDocsOpener(open = openExternalUrl, now = Date.now) {
  let active = false, last = -Infinity
  return async (integration: string, resolve: () => Promise<Resolution>, current: () => boolean) => {
    if (active || now() - last < 1000) return { outcome: "busy" as const }
    active = true
    try {
      const result = await resolve()
      if (!current()) return { outcome: "unavailable" as const }
      if (result.outcome !== "ready") return { outcome: result.outcome }
      if (!isIntegrationDocsUrl(result.url, integration)) return { outcome: "unavailable" as const }
      if (now() - last < 1000) return { outcome: "busy" as const }
      // Count at actual handoff, including explicit opener failures.
      const handed = () => {
        if (!current()) return false
        last = now()
        return true
      }
      const accepted = await open(result.url, "integration-docs", handed)
      return { outcome: accepted && current() ? "requested" as const : "unavailable" as const }
    } catch (error) { return { outcome: error instanceof PanelExtensionBusyError ? "busy" as const : "unavailable" as const } }
    finally { active = false }
  }
}
export const openBundlesDocs = createBundlesDocsOpener()
