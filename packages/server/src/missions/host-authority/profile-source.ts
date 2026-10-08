import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { SettingsService } from "../../settings/service"
import type { WorkspaceManager } from "../../workspaces/manager"
import { resolveWslServiceDirectory } from "../../workspaces/spawn"
import type { AutonomousProfileSource } from "../../opencode/missions/autonomous-environment"
import { rejectAuthority, type AuthorityBinding } from "../authority-protocol"
import { physical } from "./private-files"
import type { HostAuthorityDescriptor } from "./model"
import type { CanonicalMissionRoots } from "../durable-host/roots"

/** Call only inside authenticated Play's owned project/family fence. Bind the
 * returned source in that one signed Play, never a browser/RPC path option. */
export async function resolveStandingProfileSource(input: {
  settings: Pick<SettingsService, "configYamlPathForAuthority" | "getProfileScope">
  descriptor: HostAuthorityDescriptor
  binding: Pick<AuthorityBinding, "profileID" | "executionHost" | "projectID" | "projectCanonical" | "roots">
  manager: Pick<WorkspaceManager, "getServiceWslDistro" | "getServicePathStyle">
  roots: Pick<CanonicalMissionRoots, "assertRoots">
  workspaceID: string
  assertCurrent(): true
}, translate = resolveWslServiceDirectory, verifyNative = verifyNativeProfileFile): Promise<AutonomousProfileSource> {
  const { descriptor, binding, manager, workspaceID, assertCurrent } = input
  assertCurrent()
  if (binding.profileID !== descriptor.scope.key || binding.executionHost !== descriptor.executionHost
    || !binding.roots.length || !binding.projectID || !binding.projectCanonical) rejectAuthority("binding-mismatch")
  await input.roots.assertRoots(binding.roots)
  assertCurrent()
  const hostPath = input.settings.configYamlPathForAuthority()
  // Settings retains the desktop's established ASCII-folded Tauri identity;
  // recomputing a Unicode-folded key here would reject the same paused CREATE.
  const scope = input.settings.getProfileScope()
  if (!path.isAbsolute(hostPath) || hostPath.includes("\0") || hostPath.length > 4096
    || scope.channel !== descriptor.scope.channel || scope.configIdentity !== descriptor.scope.configIdentity || scope.key !== descriptor.scope.key
    || physical(await realpath(path.dirname(hostPath))) !== descriptor.physicalProfile) rejectAuthority("binding-mismatch")
  assertCurrent()
  const style = manager.getServicePathStyle(workspaceID)
  const distro = manager.getServiceWslDistro(workspaceID)
  if (!style || (distro ? style !== "posix" || descriptor.executionHost !== `wsl:${distro}`
    : style !== (process.platform === "win32" ? "win32" : "posix") || descriptor.executionHost !== "local")) rejectAuthority("observation-unavailable")
  await verifyReadableFile(hostPath)
  assertCurrent()
  const nativePath = distro ? await translate(hostPath, distro) : hostPath
  if (!nativePath || (distro ? !path.posix.isAbsolute(nativePath) || nativePath.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(nativePath)
    : !path.isAbsolute(nativePath))) rejectAuthority("observation-unavailable")
  if (distro) await verifyNative(nativePath, distro)
  await input.roots.assertRoots(binding.roots)
  assertCurrent()
  const selected = input.settings.getProfileScope()
  if (selected.channel !== scope.channel || selected.configIdentity !== scope.configIdentity || selected.key !== scope.key
    || input.settings.configYamlPathForAuthority() !== hostPath) rejectAuthority("binding-mismatch")
  if (manager.getServiceWslDistro(workspaceID) !== distro || manager.getServicePathStyle(workspaceID) !== style
    || (distro ? descriptor.executionHost !== `wsl:${distro}` : descriptor.executionHost !== "local")) rejectAuthority("observation-unavailable")
  return Object.freeze({ profileID: binding.profileID, executionHost: binding.executionHost, configYamlPath: nativePath })
}

async function verifyReadableFile(file: string): Promise<void> {
  try {
    // Opening the exact document (not just its parent) rejects missing files,
    // directories and unreadable endpoints; nonblocking open rejects FIFOs.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      if (!(await handle.stat()).isFile()) throw new Error("not a file")
      await handle.read(Buffer.alloc(1), 0, 1, 0)
    } finally { await handle.close() }
  } catch { rejectAuthority("observation-unavailable") }
}

async function verifyNativeProfileFile(file: string, distro: string): Promise<void> {
  try {
    // The host's mapped path alone cannot prove that this distro can read it.
    await promisify(execFile)("wsl.exe", ["--distribution", distro, "--exec", "sh", "-c",
      'test -f "$1" && head -c 1 "$1" >/dev/null', "sh", file],
    { timeout: 5_000, windowsHide: true, maxBuffer: 1024 })
  } catch { rejectAuthority("observation-unavailable") }
}
