import { accessSync, constants, realpathSync, statSync } from "node:fs"
import path from "node:path"

// The prerelease private runtime is no longer an executable source, including
// saved selections and PATH aliases. Do not read receipts or delete its files.
export function isRetiredInstallation(binary: string): boolean {
  const retired = (value: string) => /(?:^|\/)\.local\/share\/codenomad\/opencode(?:\/|$)/i
    .test(path.posix.normalize(value.replaceAll("\\", "/")))
  if (retired(binary)) return true
  // WSL/network paths are checked lexically, never synchronously probed through
  // the host filesystem just to decide whether this local tree was retired.
  if (/^(?:\\\\|\/\/)/.test(binary)) return false
  try { return retired(realpathSync(binary)) } catch { return false }
}

export function assertCurrentInstallation(binary: string, env = process.env): void {
  if (process.platform !== "win32" && !binary.includes("/")) {
    for (const directory of (env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.resolve(directory || ".", binary)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
      } catch { continue }
      binary = candidate
      break
    }
  }
  if (isRetiredInstallation(binary)) {
    throw Object.assign(new Error("opencode_private_installation_retired"), { code: "ENOENT" })
  }
}
