import { createSignal, createMemo } from "solid-js"

type LogLevel = "info" | "warn" | "error" | "debug"

interface LogEntry {
  id: number
  ts: string
  level: LogLevel
  source: string
  message: string
}

const MAX_ENTRIES = 300
let nextId = 1

const [entries, setEntries] = createSignal<LogEntry[]>([])
const [paused, setPaused] = createSignal(false)
const [visible, setVisible] = createSignal(false)

function addEntry(level: LogLevel, source: string, message: string) {
  const now = new Date()
  const ts = now.toLocaleTimeString("en-US", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0")
  const entry: LogEntry = { id: nextId++, ts, level, source, message }
  setEntries((prev) => {
    const next = [...prev, entry]
    if (next.length > MAX_ENTRIES) {
      return next.slice(next.length - MAX_ENTRIES)
    }
    return next
  })
}

function clearLog() {
  setEntries([])
}

function toggleVisibility() {
  setVisible((v) => !v)
}

function togglePause() {
  setPaused((p) => !p)
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
}
