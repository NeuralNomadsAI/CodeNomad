import debug from "debug"

export type LoggerNamespace = "sse" | "api" | "session" | "actions" | "models-api" | "commands-settings" | "session-cleanup" | "era-status" | "era-governance" | "era-directives" | "governance-advanced" | "directives-editor" | "constitution-viewer" | "github-auth" | "github-repos" | "workspace" | "mcp-settings" | "file-conflicts" | "process-manager" | "update-checker" | "activity-monitor" | "question-store" | "instruction-capture" | "instruction-retrieval"

interface Logger {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface NamespaceState {
  name: LoggerNamespace
  enabled: boolean
}

export interface LoggerControls {
  listLoggerNamespaces: () => NamespaceState[]
  enableLogger: (namespace: LoggerNamespace) => void
  disableLogger: (namespace: LoggerNamespace) => void
  enableAllLoggers: () => void
  disableAllLoggers: () => void
}

const KNOWN_NAMESPACES: LoggerNamespace[] = ["sse", "api", "session", "actions", "models-api", "commands-settings", "session-cleanup", "era-status", "era-governance", "era-directives", "governance-advanced", "directives-editor", "constitution-viewer", "github-auth", "github-repos", "workspace", "mcp-settings", "file-conflicts", "process-manager", "update-checker", "activity-monitor", "question-store", "instruction-capture", "instruction-retrieval"]
const STORAGE_KEY = "opencode:logger:namespaces"

const namespaceLoggers = new Map<LoggerNamespace, Logger>()
const enabledNamespaces = new Set<LoggerNamespace>()
const rawConsole = typeof globalThis !== "undefined" ? globalThis.console : undefined

function applyEnabledNamespaces(): void {
  if (enabledNamespaces.size === 0) {
    debug.disable()
  } else {
    debug.enable(Array.from(enabledNamespaces).join(","))
  }
}

function persistEnabledNamespaces(): void {
  if (typeof window === "undefined" || !window?.localStorage) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(enabledNamespaces)))
  } catch (error) {
    rawConsole?.warn?.("Failed to persist logger namespaces", error)
  }
}

function hydrateNamespacesFromStorage(): void {
  if (typeof window === "undefined" || !window?.localStorage) return
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) return
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return
    for (const name of parsed) {
      if (KNOWN_NAMESPACES.includes(name as LoggerNamespace)) {
        enabledNamespaces.add(name as LoggerNamespace)
      }
    }
  } catch (error) {
    rawConsole?.warn?.("Failed to hydrate logger namespaces", error)
  }
}

hydrateNamespacesFromStorage()
applyEnabledNamespaces()

function buildLogger(namespace: LoggerNamespace): Logger {
  const base = debug(namespace)
  const baseLogger: (...args: any[]) => void = base
  const formatAndLog = (level: string, args: any[]) => {
    baseLogger(level, ...args)
  }
  return {
    log: (...args: any[]) => baseLogger(...args),
    info: (...args: any[]) => baseLogger(...args),
    warn: (...args: any[]) => formatAndLog("[warn]", args),
    error: (...args: any[]) => formatAndLog("[error]", args),
  }
}

function getLogger(namespace: LoggerNamespace): Logger {
  if (!KNOWN_NAMESPACES.includes(namespace)) {
    throw new Error(`Unknown logger namespace: ${namespace}`)
  }
  if (!namespaceLoggers.has(namespace)) {
    namespaceLoggers.set(namespace, buildLogger(namespace))
  }
  return namespaceLoggers.get(namespace)!
}

function listLoggerNamespaces(): NamespaceState[] {
  return KNOWN_NAMESPACES.map((name) => ({ name, enabled: enabledNamespaces.has(name) }))
}

function enableLogger(namespace: LoggerNamespace): void {
  if (!KNOWN_NAMESPACES.includes(namespace)) {
    throw new Error(`Unknown logger namespace: ${namespace}`)
  }
  if (enabledNamespaces.has(namespace)) return
  enabledNamespaces.add(namespace)
  persistEnabledNamespaces()
  applyEnabledNamespaces()
}

function disableLogger(namespace: LoggerNamespace): void {
  if (!KNOWN_NAMESPACES.includes(namespace)) {
    throw new Error(`Unknown logger namespace: ${namespace}`)
  }
  if (!enabledNamespaces.has(namespace)) return
  enabledNamespaces.delete(namespace)
  persistEnabledNamespaces()
  applyEnabledNamespaces()
}

function disableAllLoggers(): void {
  enabledNamespaces.clear()
  persistEnabledNamespaces()
  applyEnabledNamespaces()
}

function enableAllLoggers(): void {
  KNOWN_NAMESPACES.forEach((namespace) => enabledNamespaces.add(namespace))
  persistEnabledNamespaces()
  applyEnabledNamespaces()
}

const loggerControls: LoggerControls = {
  listLoggerNamespaces,
  enableLogger,
  disableLogger,
  enableAllLoggers,
  disableAllLoggers,
}

function exposeLoggerControls(): void {
  if (typeof window === "undefined") return
  window.eraCodeLogger = loggerControls
}

exposeLoggerControls()

export {
  getLogger,
  listLoggerNamespaces,
  enableLogger,
  disableLogger,
  enableAllLoggers,
  disableAllLoggers,
}
