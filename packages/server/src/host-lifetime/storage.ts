import { lstat } from "node:fs/promises"
import { HostError } from "./protocol"
import { windowsPrivateStorage } from "./windows-storage"

export interface StoragePolicy {
  /** Windows must check the DACL/owner of the private directory and each file.
   * Unix default verifies UID/mode. The parent root must be provisioned privately. */
  verify(file: string, directory: boolean): Promise<void>
}
export const privateStorage: StoragePolicy = {
  async verify(file, directory) {
    const stat = await lstat(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1))
      throw new HostError("unsafe-storage-type")
    if (process.platform === "win32") return windowsPrivateStorage.verify(file, directory)
    if (!process.getuid || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
      throw new HostError("unsafe-storage-permissions")
  },
}
