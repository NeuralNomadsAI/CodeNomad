// Matches OpenCode's database/path.ts encoding, without changing case or
// treating POSIX backslashes as separators.
export function storageDirectory(directory: string): string {
  return process.platform === "win32" ? directory.replaceAll("\\", "/") : directory
}
