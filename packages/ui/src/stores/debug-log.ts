import { createSignal } from "solid-js"

const STORAGE_KEY = "codenomad:debug-log"
const MAX_ENTRIES = 300
const PERSIST_DEBOUNCE_MS = 1000

type LogLevel = "info" | "warn" | "error" | "debug"

interface LogEntry {
  id: number
  ts: string
  level: LogLevel
  source: string
  message: string
}

function loadPersisted(): LogEntry[] {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null
    if (raw) {
      const parsed = JSON.parse(raw) as LogEntry[]
      return Array.isArray(parsed) ? parsed : []
    }
  } catch { /* ignore */ }
  return []
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let pendingEntries: LogEntry[] | null = null

function schedulePersist(entries: LogEntry[]) {
  pendingEntries = entries
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (pendingEntries) {
      try {
        if (typeof window !== "undefined") {
          const slice = pendingEntries.slice(-MAX_ENTRIES)
          localStorage.setItem(STORAGE_KEY, JSON.stringify(slice))
        }
      } catch { /* ignore */ }
      pendingEntries = null
    }
  }, PERSIST_DEBOUNCE_MS)
}

function persistNow(entries: LogEntry[]) {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  pendingEntries = null
  try {
    if (typeof window !== "undefined") {
      const slice = entries.slice(-MAX_ENTRIES)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slice))
    }
  } catch { /* ignore */ }
}

let nextId = 1
const initial = loadPersisted()
if (initial.length > 0) {
  nextId = Math.max(...initial.map((e) => e.id), 0) + 1
}

const [entries, setEntries] = createSignal<LogEntry[]>(initial)
const [paused, setPaused] = createSignal(false)
const [visible, setVisible] = createSignal(false)

function addEntry(level: LogLevel, source: string, message: string) {
  const now = new Date()
  const ts = now.toLocaleTimeString("en-US", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0")
  const entry: LogEntry = { id: nextId++, ts, level, source, message }
  setEntries((prev) => {
    const next = [...prev, entry]
    const trimmed = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
    schedulePersist(trimmed)
    return trimmed
  })
}

function clearLog() {
  setEntries([])
  persistNow([])
}

function toggleVisibility() {
  setVisible((v) => !v)
}

function togglePause() {
  setPaused((p) => !p)
}

function exportLog(): string {
  return JSON.stringify(entries(), null, 2)
}

export function debugLog(source: string, message: string) {
  addEntry("debug", source, message)
}

export function debugInfo(source: string, message: string) {
  addEntry("info", source, message)
}

export function debugWarn(source: string, message: string) {
  addEntry("warn", source, message)
}

export function debugError(source: string, message: string) {
  addEntry("error", source, message)
}

export {
  entries,
  paused,
  visible,
  clearLog,
  toggleVisibility,
  togglePause,
  exportLog,
}
