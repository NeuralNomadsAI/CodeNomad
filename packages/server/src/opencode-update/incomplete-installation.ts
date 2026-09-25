import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/** npm can remove a failed package but leave its terminal shims behind. Only
 * recognize its exact native-executable shim in the chosen user prefix; never
 * adopt a custom wrapper, another prefix, or an existing executable for repair. */
export function isIncompleteWindowsNpmShim(command: string, prefix: string, binary: string): boolean {
  if (path.resolve(path.dirname(command)) !== path.resolve(prefix)
    || !/^opencode2?\.cmd$/i.test(path.basename(command)) || existsSync(binary)) return false
  try {
    const script = readFileSync(command, "utf8")
    if (script.length > 4096) return false
    const expected = [
      "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
      '"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe" %*',
    ]
    const lines = script.trim().split(/\r?\n/).map(line => line.trim().replace(/\s+%\*$/, " %*"))
    return lines.length === expected.length && lines.every((line, index) => line === expected[index])
  } catch { return false }
}
