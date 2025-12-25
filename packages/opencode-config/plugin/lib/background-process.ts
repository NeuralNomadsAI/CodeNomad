import path from "path"
import { tool } from "@opencode-ai/plugin/tool"

type BackgroundProcess = {
  id: string
  title: string
  command: string
  status: "running" | "stopped" | "error"
  startedAt: string
  stoppedAt?: string
  exitCode?: number
  outputSizeBytes?: number
}

type CodeNomadConfig = {
  instanceId: string
  baseUrl: string
}

type BackgroundProcessOptions = {
  baseDir: string
}

type ParsedCommand = {
  head: string
  args: string[]
}

export function createBackgroundProcessTools(config: CodeNomadConfig, options: BackgroundProcessOptions) {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {

    const base = config.baseUrl.replace(/\/+$/, "")
    const url = `${base}/workspaces/${config.instanceId}/plugin/background-processes${path}`
    const headers = normalizeHeaders(init?.headers)
    if (init?.body !== undefined) {
      headers["Content-Type"] = "application/json"
    }

    const response = await fetch(url, {
      ...init,
      headers,
    })

    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || `Request failed with ${response.status}`)
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }

  return {
    run_background_process: tool({
      description:
        "Run a long-lived background process (dev servers, DBs, watchers) so it keeps running while you do other tasks. Use it for running processes that timeout otherwise or produce a lot of output.",
      args: {
        title: tool.schema.string().describe("Short label for the process (e.g. Dev server, DB server)"),
        command: tool.schema.string().describe("Shell command to run in the workspace"),
      },
      async execute(args) {
        assertCommandWithinBase(args.command, options.baseDir)
        const process = await request<BackgroundProcess>("", {
          method: "POST",
          body: JSON.stringify({ title: args.title, command: args.command }),
        })

        return `Started background process ${process.id} (${process.title})\nStatus: ${process.status}\nCommand: ${process.command}`
      },
    }),
    list_background_processes: tool({
      description: "List background processes running for this workspace.",
      args: {},
      async execute() {
        const response = await request<{ processes: BackgroundProcess[] }>("")
        if (response.processes.length === 0) {
          return "No background processes running."
        }

        return response.processes
          .map((process) => {
            const status = process.status === "running" ? "running" : process.status
            const exit = process.exitCode !== undefined ? ` (exit ${process.exitCode})` : ""
            const size =
              typeof process.outputSizeBytes === "number" ? ` | ${Math.round(process.outputSizeBytes / 1024)}KB` : ""
            return `- ${process.id} | ${process.title} | ${status}${exit}${size}\n  ${process.command}`
          })
          .join("\n")
      },
    }),
    read_background_process_output: tool({
      description: "Read output from a background process. Use full, grep, head, or tail.",
      args: {
        id: tool.schema.string().describe("Background process ID"),
        method: tool.schema
          .enum(["full", "grep", "head", "tail"])
          .default("full")
          .describe("Method to read output"),
        pattern: tool.schema.string().optional().describe("Pattern for grep method"),
        lines: tool.schema.number().optional().describe("Number of lines for head/tail methods"),
      },
      async execute(args) {
        if (args.method === "grep" && !args.pattern) {
          return "Pattern is required for grep method."
        }

        const params = new URLSearchParams({ method: args.method })
        if (args.pattern) {
          params.set("pattern", args.pattern)
        }
        if (args.lines) {
          params.set("lines", String(args.lines))
        }

        const response = await request<{ id: string; content: string; truncated: boolean; sizeBytes: number }>(
          `/${args.id}/output?${params.toString()}`,
        )

        const header = response.truncated
          ? `Output (truncated, ${Math.round(response.sizeBytes / 1024)}KB):`
          : `Output (${Math.round(response.sizeBytes / 1024)}KB):`

        return `${header}\n\n${response.content}`
      },
    }),
    stop_background_process: tool({
      description: "Stop a background process (SIGTERM) but keep its output and entry.",
      args: {
        id: tool.schema.string().describe("Background process ID"),
      },
      async execute(args) {
        const process = await request<BackgroundProcess>(`/${args.id}/stop`, { method: "POST" })
        return `Stopped background process ${process.id} (${process.title}). Status: ${process.status}`
      },
    }),
    terminate_background_process: tool({
      description: "Terminate a background process and delete its output + entry.",
      args: {
        id: tool.schema.string().describe("Background process ID"),
      },
      async execute(args) {
        await request<void>(`/${args.id}/terminate`, { method: "POST" })
        return `Terminated background process ${args.id} and removed its output.`
      },
    }),
  }
}

const FILE_COMMANDS = new Set(["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown"])
const EXPANSION_CHARS = /[~*$?\[\]`$]/

function assertCommandWithinBase(command: string, baseDir: string) {
  const normalizedBase = path.resolve(baseDir)
  const commands = splitCommands(command)

  for (const item of commands) {
    if (!FILE_COMMANDS.has(item.head)) {
      continue
    }

    for (const arg of item.args) {
      if (!arg) continue
      if (arg.startsWith("-") || (item.head === "chmod" && arg.startsWith("+"))) continue

      const literalArg = unquote(arg)
      if (EXPANSION_CHARS.test(literalArg)) {
        throw new Error(`Background process commands may only reference paths within ${normalizedBase}.`)
      }

      const resolved = path.isAbsolute(literalArg) ? path.normalize(literalArg) : path.resolve(normalizedBase, literalArg)
      if (!isWithinBase(normalizedBase, resolved)) {
        throw new Error(`Background process commands may only reference paths within ${normalizedBase}.`)
      }
    }
  }
}

function splitCommands(command: string): ParsedCommand[] {
  const tokens = tokenize(command)
  const commands: ParsedCommand[] = []
  let current: string[] = []

  for (const token of tokens) {
    if (isSeparator(token)) {
      if (current.length > 0) {
        commands.push({ head: current[0], args: current.slice(1) })
        current = []
      }
      continue
    }
    current.push(token)
  }

  if (current.length > 0) {
    commands.push({ head: current[0], args: current.slice(1) })
  }

  return commands
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escape = false

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current)
      current = ""
    }
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]

    if (escape) {
      current += char
      escape = false
      continue
    }

    if (char === "\\" && quote !== "'") {
      escape = true
      continue
    }

    if (quote) {
      current += char
      if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }

    if (char === " " || char === "\n" || char === "\t") {
      flush()
      continue
    }

    if (char === "|" || char === "&" || char === ";") {
      flush()
      const next = input[index + 1]
      if ((char === "|" || char === "&") && next === char) {
        tokens.push(char + next)
        index += 1
      } else {
        tokens.push(char)
      }
      continue
    }

    current += char
  }

  flush()
  return tokens
}

function isSeparator(token: string) {
  return token === "|" || token === "||" || token === "&&" || token === ";" || token === "&"
}

function unquote(value: string) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1)
    }
  }
  return value
}

function isWithinBase(baseDir: string, target: string) {
  const relative = path.relative(baseDir, target)
  if (!relative) return true
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const output: Record<string, string> = {}
  if (!headers) return output

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      output[key] = value
    })
    return output
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      output[key] = value
    }
    return output
  }

  return { ...headers }
}
