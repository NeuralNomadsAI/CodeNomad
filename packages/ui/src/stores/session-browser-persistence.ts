import { readClientLayoutValue, writeClientLayoutValue } from "./client-state"
import { mergeSessionBrowsers, parseLegacySessionPreviews, SESSION_BROWSER_STATE_KEY,
  type RestorableBrowserPreview, type RestorableTabViewState } from "./tab-view-state-codec"

export function savedSessionBrowser(sessionId: string): RestorableBrowserPreview | undefined {
  return new Map(parseLegacySessionPreviews(readClientLayoutValue(SESSION_BROWSER_STATE_KEY))).get(sessionId)
}

export function saveSessionBrowser(sessionId: string, preview: RestorableBrowserPreview): void {
  writeClientLayoutValue(SESSION_BROWSER_STATE_KEY, mergeSessionBrowsers(
    [{ version: 1, previews: { [sessionId]: preview } }], readClientLayoutValue(SESSION_BROWSER_STATE_KEY)))
}

export function importSessionBrowsers(views: readonly (RestorableTabViewState | undefined)[]): boolean {
  if (!views.some(view => Object.values(view?.previews ?? {}).some(p => p.targetUrl))) return true
  const value = mergeSessionBrowsers(views, readClientLayoutValue(SESSION_BROWSER_STATE_KEY))
  return writeClientLayoutValue(SESSION_BROWSER_STATE_KEY, value)
}
