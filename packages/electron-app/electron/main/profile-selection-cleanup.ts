import { lstatSync, readdirSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

/**
 * Electron asks the one-time profile question from a throwaway Chromium storage folder. The asking
 * process cannot reliably delete it while Chromium still holds its files (Windows), so the
 * relaunched process removes the folder named in SELECTION_CLEANUP_ENVIRONMENT, and every launch
 * sweeps older leftovers (for example after Quit, a crash, or an unremembered answer).
 */
export const SELECTION_TEMP_PREFIX = "codenomad-profile-selection-"
export const SELECTION_CLEANUP_ENVIRONMENT = "CODENOMAD_PROFILE_SELECTION_CLEANUP"
export const SELECTION_TEMP_MAX_AGE_MS = 10 * 60 * 1000

function removeSelectionFolder(path: string): boolean {
  try {
    const stats = lstatSync(path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false
    rmSync(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Removes the named folder (only if it is a direct `codenomad-profile-selection-*` child of
 * `temporaryRoot`) and any such folder older than `maxAgeMs`. Never follows links or touches
 * anything else. Returns the removed paths.
 */
export function sweepSelectionFolders(options: {
  temporaryRoot: string
  named?: string
  now?: number
  maxAgeMs?: number
}): string[] {
  const root = resolve(options.temporaryRoot)
  const now = options.now ?? Date.now()
  const maxAge = options.maxAgeMs ?? SELECTION_TEMP_MAX_AGE_MS
  const removed: string[] = []
  const named = options.named ? resolve(options.named) : undefined
  if (named && dirname(named) === root && basename(named).startsWith(SELECTION_TEMP_PREFIX) && removeSelectionFolder(named)) {
    removed.push(named)
  }
  let entries: string[]
  try { entries = readdirSync(root) } catch { return removed }
  for (const entry of entries) {
    if (!entry.startsWith(SELECTION_TEMP_PREFIX)) continue
    const path = join(root, entry)
    if (path === named) continue
    try {
      if (now - lstatSync(path).mtimeMs < maxAge) continue
    } catch {
      continue
    }
    if (removeSelectionFolder(path)) removed.push(path)
  }
  return removed
}
