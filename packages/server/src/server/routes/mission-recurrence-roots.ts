import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { AuthorityRoot } from "../../missions/authority-protocol"
import { physical } from "../../missions/physical-path"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { canonicalWorktreeIdentity, type WorkspaceManager } from "../../workspaces/manager"
import { resolveRepoRoot } from "../../workspaces/git-worktrees"

const executeFile = promisify(execFile)
type Manager = Pick<WorkspaceManager, "getHostPathForServicePath" | "getWorktreeIdentityForPath">
export type WslGit = (distro: string, executable: "git" | "realpath", args: string[]) => Promise<string>
const executeWsl: WslGit = async (distro, executable, args) => {
  const { stdout } = await executeFile("wsl.exe", ["--distribution", distro, "--exec", executable, ...args], {
    windowsHide: true, timeout: 10_000, maxBuffer: 4096, encoding: "utf8",
  })
  return stdout.trimEnd()
}
const linuxPath = (value: string) => {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\n") || path.posix.normalize(value) !== value
    || value.length > 240) throw new Error("Invalid native WSL root identity")
  return value
}

/** Paused metadata root, not an authority claim. Native Linux paths remain in
 * Linux's identity domain; host translations are only used to verify ownership. */
export async function resolveRecurrenceRoot(manager: Manager, workspaceID: string, directory: string,
  projectCanonical: string, distro?: string, runWsl: WslGit = executeWsl): Promise<Extract<AuthorityRoot, { mode: "git" }>> {
  const [host, canonicalHost, checkout] = await Promise.all([
    manager.getHostPathForServicePath(workspaceID, directory),
    manager.getHostPathForServicePath(workspaceID, projectCanonical),
    manager.getWorktreeIdentityForPath(workspaceID, directory),
  ])
  // Deletion identities may be opaque WSL keys, never filesystem paths.
  if (!host || !canonicalHost || !checkout) {
    throw new Error("Physical recurrence checkout unavailable")
  }
  if (!distro) {
    const [family, canonicalFamily, resolved] = await Promise.all([
      readFamilyAuthorityIdentity(host), readFamilyAuthorityIdentity(canonicalHost), resolveRepoRoot(host),
    ])
    if (family !== canonicalFamily) throw new Error("Foreign recurrence Git family")
    const root = await realpath(resolved.repoRoot)
    if (!resolved.isGitRepo || canonicalWorktreeIdentity(root) !== checkout) throw new Error("Physical recurrence checkout unavailable")
    return { mode: "git", directory, family, checkout: physical(root) }
  }
  const nativeFamily = linuxPath((await runWsl(distro, "git", ["-C", directory,
    "rev-parse", "--path-format=absolute", "--git-common-dir"])).trim())
  const [nativeDirectory, nativeCheckout, nativeCommon, canonicalCommon] = await Promise.all([
    runWsl(distro, "realpath", ["-e", directory]),
    runWsl(distro, "git", ["-C", directory, "rev-parse", "--show-toplevel"])
      .then(root => runWsl(distro, "realpath", ["-e", linuxPath(root.trim())])),
    runWsl(distro, "realpath", ["-e", nativeFamily]),
    runWsl(distro, "git", ["-C", projectCanonical, "rev-parse", "--path-format=absolute", "--git-common-dir"])
      .then(common => runWsl(distro, "realpath", ["-e", linuxPath(common.trim())])),
  ])
  const nativeRoot = linuxPath(nativeCheckout.trim())
  const checkoutHost = await manager.getHostPathForServicePath(workspaceID, nativeRoot)
  if (!checkoutHost || canonicalWorktreeIdentity(await realpath(checkoutHost)) !== checkout
    || linuxPath(nativeDirectory.trim()) !== directory || linuxPath(nativeCommon.trim()) !== linuxPath(canonicalCommon.trim())) {
    throw new Error("Native WSL recurrence root differs")
  }
  return { mode: "git", directory, family: linuxPath(nativeCommon.trim()), checkout: nativeRoot }
}
