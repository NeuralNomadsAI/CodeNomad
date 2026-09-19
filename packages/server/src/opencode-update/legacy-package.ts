import { readFileSync, realpathSync, statSync } from "node:fs"
import type { OpenCodePackageManager } from "./service"

const LEGACY_PACKAGE = "@opencode-ai/cli"
const LEGACY_BIN = /(?:^|[\\/])@opencode-ai[\\/]cli[\\/]bin[\\/]opencode2(?:\.exe)?(?:["'\s]|$)/

/** Migrate only an entry point belonging to the old V2 package. npm otherwise
 * rejects the new package's opencode2 alias with EEXIST. Do not use --force to
 * overwrite commands belonging to an unrelated installation. */
export function legacyOpenCodeRemoval(
  binaryPath: string,
  manager: OpenCodePackageManager,
): { command: string; args: string[] } | undefined {
  let legacy = false
  try {
    const resolved = realpathSync(binaryPath)
    legacy = LEGACY_BIN.test(resolved)
    // npm/pnpm Windows entry points are small scripts, not symlinks. Never read
    // a whole native executable merely to identify its package.
    if (!legacy && statSync(resolved).size <= 64 * 1024) {
      legacy = LEGACY_BIN.test(readFileSync(resolved, "utf8"))
    }
  } catch {
    return undefined
  }
  if (!legacy) return undefined
  if (manager === "yarn") return { command: "yarn", args: ["global", "remove", LEGACY_PACKAGE] }
  return { command: manager, args: [manager === "npm" ? "uninstall" : "remove", "-g", LEGACY_PACKAGE] }
}
