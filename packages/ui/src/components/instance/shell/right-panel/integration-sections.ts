import type { IntegrationView } from "../../../../../../server/src/integration-types"

export const INTEGRATION_SECTION_PREFIX = "integration:"
/** Default rank: right after Plugins (60), in catalogue order. */
export const INTEGRATION_SECTION_ORDER = 61

export const integrationSectionId = (integrationId: string) => `${INTEGRATION_SECTION_PREFIX}${integrationId}`

/**
 * A section exists while the integration is declared or its plugin loaded or failed, disabled, pending or
 * non-conforming included; a retained rule alone or an ambiguous source has none.
 */
export function hasIntegrationSection(entry: Pick<IntegrationView, "plugin" | "ambiguous">): boolean {
  return !entry.ambiguous && (entry.plugin.declared || entry.plugin.runtime !== undefined)
}

/** Catalogue IDs of the integrations that have a section, in catalogue order. */
export function integrationSectionIds(entries: readonly Pick<IntegrationView, "id" | "plugin" | "ambiguous">[]): string[] {
  return entries.filter(hasIntegrationSection).map(entry => entry.id)
}
