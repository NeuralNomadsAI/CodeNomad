import { renameRecentFolderProject } from "./preferences"
import { updateProjectNameForFolder } from "./instances"
import { LOCAL_SERVER_ID } from "../lib/project-identity"

/** One display name per server/directory: its recent entry and every open occurrence. */
export async function renameProject(folder: string, name: string, serverId = LOCAL_SERVER_ID): Promise<void> {
  await renameRecentFolderProject(folder, name, serverId)
  updateProjectNameForFolder(folder, name, serverId)
}
