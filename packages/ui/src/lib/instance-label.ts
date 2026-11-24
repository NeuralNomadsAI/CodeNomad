export function getPathBasename(path: string): string {
  // Instance folders can be POSIX-like (/Users/...) on macOS/Linux or Windows-like (C:\Users\...).
  // Normalize by trimming trailing separators and then splitting on both '/' and '\\'.
  const normalized = path.replace(/[\\/]+$/, "")
  return normalized.split(/[\\/]/).pop() || path
}

/** The label an instance tab shows: its project name, else its folder name. */
export function getInstanceLabel(instance: { projectName?: string; folder: string }): string {
  return instance.projectName?.trim() || getPathBasename(instance.folder)
}
