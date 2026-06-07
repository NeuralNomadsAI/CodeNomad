import { isElectronHost } from "../runtime-env"

export function getFilePath(file: File): string | null {
  if (typeof file.path === "string" && file.path.trim().length > 0) {
    return file.path
  }
  if (isElectronHost()) {
    const electronPath = (window as Window & { electronAPI?: ElectronAPI }).electronAPI?.getPathForFile?.(file)
    if (typeof electronPath === "string" && electronPath.trim().length > 0) {
      return electronPath
    }
  }
  return null
}
