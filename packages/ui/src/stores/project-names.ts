import { renameRecentFolderProject } from "./preferences"
import { updateProjectNameForFolder } from "./instances"
import { LOCAL_BACKEND_ID } from "../lib/backend-identity"
import type { BackendId } from "../lib/backend-transport"

/** One display name per project, a folder of one backend: its recent-folder entry and every open tab of it. */
export async function renameProject(folder: string, name: string, backendId: BackendId = LOCAL_BACKEND_ID): Promise<void> {
  // Recent folders list the local backend's folders.
  if (backendId === LOCAL_BACKEND_ID) await renameRecentFolderProject(folder, name)
  updateProjectNameForFolder(folder, name, backendId)
}
