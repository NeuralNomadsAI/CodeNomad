import { renameRecentFolderProject } from "./preferences"
import { updateProjectNameForFolder } from "./instances"

/** One display name per project folder: its recent-folder entry and every open tab of it. */
export async function renameProject(folder: string, name: string): Promise<void> {
  await renameRecentFolderProject(folder, name)
  updateProjectNameForFolder(folder, name)
}
