// Shared presentation of recent project folders (home page and new-instance launcher).

type Translate = (key: string, params?: Record<string, unknown>) => string

function looksLikeWindowsPath(value: string): boolean {
  if (!value) return false
  // Drive letter (C:\...) or UNC (\\server\share\...)
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
}

export function splitFolderPath(rawPath: string): { baseName: string; dirName: string } {
  if (!rawPath) return { baseName: "", dirName: "" }

  const isWindows = looksLikeWindowsPath(rawPath)
  const trimmed = rawPath.replace(/[\\/]+$/, "")

  // Root edge-cases ("/", "C:\\", "\\\\server\\share\\")
  if (!trimmed) {
    return { baseName: rawPath, dirName: "" }
  }

  if (isWindows && /^[A-Za-z]:$/.test(trimmed)) {
    return { baseName: `${trimmed}\\`, dirName: "" }
  }

  const lastSlash = trimmed.lastIndexOf("/")
  const lastBackslash = isWindows ? trimmed.lastIndexOf("\\") : -1
  const lastSep = Math.max(lastSlash, lastBackslash)

  if (lastSep < 0) {
    return { baseName: trimmed, dirName: "" }
  }

  const baseName = trimmed.slice(lastSep + 1) || trimmed
  const dirName = trimmed.slice(0, lastSep)
  return { baseName, dirName }
}

export function getProjectDisplayName(path: string, projectName?: string): string {
  const trimmedName = projectName?.trim()
  return trimmedName || splitFolderPath(path).baseName
}

/** Abbreviates the user's home directory to `~` on macOS, Linux and Windows. */
export function getDisplayPath(path: string): string {
  if (!path) return path

  // macOS: /Users/<name>/...
  if (path.startsWith("/Users/")) {
    return path.replace(/^\/Users\/[^/]+/, "~")
  }

  // Linux: /home/<name>/...
  if (path.startsWith("/home/")) {
    return path.replace(/^\/home\/[^/]+/, "~")
  }

  // Windows: C:\Users\<name>\... (and the forward-slash variant)
  if (/^[A-Za-z]:\\Users\\/.test(path)) {
    return path.replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~")
  }
  if (/^[A-Za-z]:\/Users\//.test(path)) {
    return path.replace(/^[A-Za-z]:\/Users\/[^/]+/, "~")
  }

  return path
}

export function formatRelativeTime(t: Translate, timestamp: number, now = Date.now()): string {
  const seconds = Math.floor((now - timestamp) / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return t("time.relative.daysAgoShort", { count: days })
  if (hours > 0) return t("time.relative.hoursAgoShort", { count: hours })
  if (minutes > 0) return t("time.relative.minutesAgoShort", { count: minutes })
  return t("time.relative.justNow")
}
