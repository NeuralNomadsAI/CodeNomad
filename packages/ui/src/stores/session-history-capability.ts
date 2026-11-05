import { instances } from "./instances"
import { explicitSessionDirectory } from "./session-inventory-scope"
import { tGlobal } from "../lib/i18n"

/** E1 explicit servers expose native pages; enriched readers stay local. */
export function isExplicitHistory(instanceId: string): boolean {
  return explicitSessionDirectory(instances().get(instanceId)) !== undefined
}

export function requireHistoryEnrichment(instanceId: string): void {
  if (isExplicitHistory(instanceId)) throw new Error(tGlobal("history.explicit.enrichmentUnavailable"))
}

export class UnavailableHistoryAnchorError extends Error {
  constructor() { super(tGlobal("history.explicit.anchorUnavailable")) }
}
