import { stripVTControlCharacters } from "node:util"

function helpOutput(stdout: unknown, stderr?: unknown): string {
  return stripVTControlCharacters([stdout, stderr]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join("\n"))
    .replace(/\r/g, "")
}

export function isOpenCodeServiceCommandUnavailable(stdout: unknown, stderr?: unknown): boolean {
  const output = helpOutput(stdout, stderr)
  const commandsIndex = output.search(/^Commands:\s*$/im)
  if (commandsIndex < 0) return false

  const commandLines = output
    .slice(commandsIndex)
    .split("\n")
    .filter((line) => /^\s*opencode(?:2)?(?:\s|$)/i.test(line))

  return commandLines.length > 0
    && !commandLines.some((line) => /^\s*opencode(?:2)?\s+service(?:\s|$)/i.test(line))
}

export function isOpenCodeServiceHelp(stdout: unknown, stderr?: unknown): boolean {
  const output = helpOutput(stdout, stderr)
  // Require the service namespace and the commands we actually use. A zero
  // exit, version number, root help or running daemon alone proves nothing.
  if (!/^\s*opencode(?:2)?\s+service(?:\s|$)/im.test(output)) return false
  const commands = output.split(/^\s*(?:SUBCOMMANDS|Commands:)\s*$/im)[1]
  if (!commands) return false
  return ["start", "status", "get"].every((command) => new RegExp(
    `^\\s*(?:opencode(?:2)?\\s+service\\s+)?${command}(?:\\s|$)`, "im",
  ).test(commands))
}
