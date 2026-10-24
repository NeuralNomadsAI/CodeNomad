import { lstatSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * Older builds ask a profile question from a throwaway `%TEMP%/codenomad-profile-selection-*`
 * Chromium storage folder that Windows may keep locked while the asking process exits, so every
 * launch sweeps such leftovers once nothing has touched them for a while.
 */
export const SELECTION_TEMP_PREFIX = "codenomad-profile-selection-"
export const SELECTION_TEMP_MAX_AGE_MS = 10 * 60 * 1000
/**
 * Private hand-offs an older build's question process sets before relaunching its executable,
 * which an update may have replaced with this build. Nothing reads them here; they are removed so
 * the backend, terminals and relaunches never carry them (an older build would act on them).
 */
export const PRIVATE_RELAUNCH_ENVIRONMENT = ["CODENOMAD_PROFILE_SELECTION_CLEANUP", "CODENOMAD_PROFILE_SELECTION_ANSWER"] as const

/** Removes the older builds' private relaunch variables from an environment. */
export function stripPrivateRelaunchEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of PRIVATE_RELAUNCH_ENVIRONMENT) delete environment[name]
}

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
 * Removes every direct `codenomad-profile-selection-*` folder of `temporaryRoot` older than
 * `maxAgeMs`. Never follows links or touches anything else. Returns the removed paths.
 */
export function sweepSelectionFolders(options: {
  temporaryRoot: string
  now?: number
  maxAgeMs?: number
}): string[] {
  const root = resolve(options.temporaryRoot)
  const now = options.now ?? Date.now()
  const maxAge = options.maxAgeMs ?? SELECTION_TEMP_MAX_AGE_MS
  const removed: string[] = []
  let entries: string[]
  try { entries = readdirSync(root) } catch { return removed }
  for (const entry of entries) {
    if (!entry.startsWith(SELECTION_TEMP_PREFIX)) continue
    const path = join(root, entry)
    try {
      if (now - lstatSync(path).mtimeMs < maxAge) continue
    } catch {
      continue
    }
    if (removeSelectionFolder(path)) removed.push(path)
  }
  return removed
}
