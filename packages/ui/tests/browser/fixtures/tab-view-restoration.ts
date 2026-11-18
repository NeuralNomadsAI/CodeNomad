import { createEffect, createRoot } from "solid-js"
import { getTabViewState, seedTabViewState } from "../../../src/stores/tab-view-state"

/** Standalone component fixtures have no App workspace capture/restore hook. */
export function restoreFixtureTabView(instanceId: string) {
  const key = `fixture-tab-view-${instanceId}`
  const saved = localStorage.getItem(key)
  if (saved) seedTabViewState(instanceId, JSON.parse(saved))
  createRoot(() => createEffect(() => localStorage.setItem(key, JSON.stringify(getTabViewState(instanceId)))))
}
