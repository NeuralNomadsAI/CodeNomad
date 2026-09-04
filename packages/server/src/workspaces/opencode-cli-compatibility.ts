const ANSI_ESCAPE_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g

export function isOpenCodeServiceCommandUnavailable(stdout: unknown, stderr?: unknown): boolean {
  const output = [stdout, stderr]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join("\n")
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(/\r/g, "")

  const commandsIndex = output.search(/^Commands:\s*$/im)
  if (commandsIndex < 0) return false

  const commandLines = output
    .slice(commandsIndex)
    .split("\n")
    .filter((line) => /^\s*opencode(?:2)?(?:\s|$)/i.test(line))

  return commandLines.length > 0
    && !commandLines.some((line) => /^\s*opencode(?:2)?\s+service(?:\s|$)/i.test(line))
}
