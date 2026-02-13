export interface KeyboardShortcut {
  key: string
  meta?: boolean
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export type Resolvable<T> = T | (() => T)

export function resolveResolvable<T>(value: Resolvable<T>): T {
  return typeof value === "function" ? (value as () => T)() : value
}

export interface Command {
  id: string
  label: Resolvable<string>
  description: Resolvable<string>
  keywords?: Resolvable<string[]>
  shortcut?: KeyboardShortcut
  disabled?: Resolvable<boolean>
  action: () => void | Promise<void>
  category?: Resolvable<string>
}

export function createCommandRegistry() {
  const commands = new Map<string, Command>()

  function register(command: Command) {
    commands.set(command.id, command)
  }

  function unregister(id: string) {
    commands.delete(id)
  }

  function get(id: string) {
    return commands.get(id)
  }

  function getAll() {
    return Array.from(commands.values())
  }

  function execute(id: string) {
    const command = commands.get(id)
    if (command) {
      return command.action()
    }
  }

  function search(query: string) {
    if (!query) return getAll()

    const lowerQuery = query.toLowerCase()
    return getAll().filter((cmd) => {
      const label = resolveResolvable(cmd.label)
      const description = resolveResolvable(cmd.description)
      const keywords = cmd.keywords ? resolveResolvable(cmd.keywords) : undefined
      const category = cmd.category ? resolveResolvable(cmd.category) : undefined
      const labelMatch = label.toLowerCase().includes(lowerQuery)
      const descMatch = description.toLowerCase().includes(lowerQuery)
      const keywordMatch = keywords?.some((k) => k.toLowerCase().includes(lowerQuery))
      const categoryMatch = category?.toLowerCase().includes(lowerQuery)
      return labelMatch || descMatch || keywordMatch || categoryMatch
    })
  }

  return {
    register,
    unregister,
    get,
    getAll,
    execute,
    search,
  }
}

export type CommandRegistry = ReturnType<typeof createCommandRegistry>
