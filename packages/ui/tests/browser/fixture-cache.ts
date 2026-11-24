import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** Concurrent Vite fixtures must not invalidate one another's optimized deps.
 * Each server owns a fresh cache; never remove a shared checkout/user cache. */
export async function createFixtureCache() {
  const temporaryRoot = process.platform === "win32" ? path.join(tmpdir(), "opencode") : tmpdir()
  await mkdir(temporaryRoot, { recursive: true })
  const cacheDir = await mkdtemp(path.join(temporaryRoot, "codenomad-browser-vite-"))
  return { cacheDir, dispose: () => rm(cacheDir, { recursive: true, force: true }) }
}
