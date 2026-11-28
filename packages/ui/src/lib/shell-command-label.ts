export interface ShellCommandLabel {
  program: string
  args: string
}

// Display only: unfamiliar syntax stays raw instead of approximating shell parsing.
export function shellCommandLabel(command: string): ShellCommandLabel | null {
  return commandLabel(command, 0)
}

function commandLabel(command: string, depth: number): ShellCommandLabel | null {
  if (depth > 4) return null
  if (/[|&;<>\r\n`$]/.test(command)) return null
  const tokens = [...command.matchAll(/"[^"]*"|'[^']*'|[^\s"']+/g)]
  if (!tokens.length) return null
  let end = 0
  for (const token of tokens) {
    if (command.slice(end, token.index).trim() || (end > 0 && token.index === end)) return null
    end = token.index! + token[0].length
  }
  if (command.slice(end).trim()) return null
  const value = (index: number) => tokens[index]?.[0].replace(/^(["'])(.*)\1$/, "$2") ?? ""
  const executable = value(0).split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "")
  const rest = (index: number) => command.slice(tokens[index]?.index ?? command.length).trim()
  if (executable === "cmd") {
    const payload = rest(2)
    return value(1).toLowerCase() === "/c" && !/^"|[%!^]/.test(payload) ? commandLabel(payload, depth + 1) : null
  }
  if (executable === "wsl") return value(1) === "-e" ? commandLabel(rest(2), depth + 1) : null
  if (["bash", "sh", "zsh"].includes(executable ?? "")) {
    if (value(1) !== "-lc" || tokens.length !== 3 || !tokens[2][0].startsWith("'")) return null
    const payload = value(2)
    if (/[\\*?[\]{}#~]/.test(payload)) return null
    return commandLabel(payload, depth + 1)
  }
  if (["pwsh", "powershell"].includes(executable ?? "")) {
    const file = value(1).toLowerCase() === "-noprofile" ? 2 : 1
    const script = value(file + 1)
    if (value(file).toLowerCase() !== "-file" || !script || script.startsWith("-") || /^[\w]+=/.test(script)) return null
    return { program: script.split(/[\\/]/).pop()!, args: rest(file + 2) }
  }
  if (/^[\w]+=/u.test(value(0))) return null
  // Keep the launcher and script together so node/python invocations remain faithful.
  if (["node", "python", "python3", "ruby"].includes(executable ?? "") && tokens[1] && !value(1).startsWith("-")) {
    return { program: command.slice(tokens[0].index, tokens[1].index! + tokens[1][0].length).trim(), args: rest(2) }
  }
  if (executable === "npm" && value(1) === "run" && tokens[2] && !value(2).startsWith("-")) {
    return { program: command.slice(tokens[0].index, tokens[2].index! + tokens[2][0].length).trim(), args: rest(3) }
  }
  return null
}
