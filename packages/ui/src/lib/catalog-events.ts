// OpenCode answers catalog reads with whatever plugins have loaded so far, so a list
// read right after startup can be empty or partial; these events announce the rest.
const CATALOG_EVENTS: ReadonlySet<string> = new Set(["model.updated", "provider.updated", "plugin.updated", "models-dev.refreshed"])

export const isCatalogEvent = (type: string) => CATALOG_EVENTS.has(type)
