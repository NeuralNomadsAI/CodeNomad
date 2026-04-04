import { runtimeEnv } from "./runtime-env"

type PerfDetail = Record<string, unknown> | undefined

export interface PerfTraceEntry {
  name: string
  time: number
  absoluteTime: number
  host: string
  platform: string
  path: string
  detail?: PerfDetail
}

interface PerfSummary {
  runtimeHost: string
  runtimePlatform: string
  loaderToCliReadyMs?: number
  loaderToNavigateMs?: number
  bootstrapToAppMountMs?: number
  bootstrapToFirstFrameMs?: number
  bootstrapToFirstContentMs?: number
}

const TRACE_STORAGE_KEY = "codenomad:perf-trace"
const WINDOW_NAME_PREFIX = "__CODENOMAD_PERF__:"
const TRACE_RETENTION_LIMIT = 200
const TRACE_STALE_AFTER_MS = 10 * 60 * 1000

let inMemoryTrace: PerfTraceEntry[] | null = null

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

function absoluteNowMs() {
  if (typeof performance !== "undefined" && typeof performance.timeOrigin === "number") {
    return performance.timeOrigin + performance.now()
  }
  return Date.now()
}

function getCurrentPath() {
  if (typeof window === "undefined" || !window.location) {
    return ""
  }
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function supportsSessionStorage() {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined"
}

function loadTraceFromWindowName(): PerfTraceEntry[] {
  if (typeof window === "undefined" || !window.name.startsWith(WINDOW_NAME_PREFIX)) {
    return []
  }

  try {
    const parsed = JSON.parse(window.name.slice(WINDOW_NAME_PREFIX.length))
    return Array.isArray(parsed) ? (parsed as PerfTraceEntry[]) : []
  } catch {
    return []
  }
}

function persistTrace(trace: PerfTraceEntry[]) {
  const trimmed = trace.slice(-TRACE_RETENTION_LIMIT)
  inMemoryTrace = trimmed

  if (supportsSessionStorage()) {
    try {
      window.sessionStorage.setItem(TRACE_STORAGE_KEY, JSON.stringify(trimmed))
    } catch {
      /* noop */
    }
  }

  if (typeof window !== "undefined") {
    try {
      window.name = `${WINDOW_NAME_PREFIX}${JSON.stringify(trimmed)}`
    } catch {
      /* noop */
    }
  }

  publishPerfHandle(trimmed)
}

function readStoredTrace(): PerfTraceEntry[] {
  if (inMemoryTrace) {
    return inMemoryTrace
  }

  let parsed: PerfTraceEntry[] = []

  if (supportsSessionStorage()) {
    try {
      const raw = window.sessionStorage.getItem(TRACE_STORAGE_KEY)
      if (raw) {
        const value = JSON.parse(raw)
        if (Array.isArray(value)) {
          parsed = value as PerfTraceEntry[]
        }
      }
    } catch {
      parsed = []
    }
  }

  if (parsed.length === 0) {
    parsed = loadTraceFromWindowName()
  }

  const lastEntry = parsed[parsed.length - 1]
  if (lastEntry && Math.abs(absoluteNowMs() - lastEntry.absoluteTime) > TRACE_STALE_AFTER_MS) {
    parsed = []
  }

  inMemoryTrace = parsed
  publishPerfHandle(parsed)
  return parsed
}

function getFirstMarkTime(trace: PerfTraceEntry[], name: string) {
  const entry = trace.find((item) => item.name === name)
  return entry?.absoluteTime
}

function durationBetween(trace: PerfTraceEntry[], start: string, end: string) {
  const startTime = getFirstMarkTime(trace, start)
  const endTime = getFirstMarkTime(trace, end)
  if (typeof startTime !== "number" || typeof endTime !== "number" || endTime < startTime) {
    return undefined
  }
  return Math.round((endTime - startTime) * 100) / 100
}

export function getPerfTrace() {
  return [...readStoredTrace()]
}

export function summarizePerfTrace(trace = readStoredTrace()): PerfSummary {
  return {
    runtimeHost: runtimeEnv.host,
    runtimePlatform: runtimeEnv.platform,
    loaderToCliReadyMs: durationBetween(trace, "loading.screen.mounted", "loading.tauri.cli.ready"),
    loaderToNavigateMs: durationBetween(trace, "loading.screen.mounted", "loading.navigate"),
    bootstrapToAppMountMs: durationBetween(trace, "ui.bootstrap.start", "ui.app.mounted"),
    bootstrapToFirstFrameMs: durationBetween(trace, "ui.bootstrap.start", "ui.app.first-frame"),
    bootstrapToFirstContentMs: durationBetween(trace, "ui.bootstrap.start", "ui.session.first-content"),
  }
}

function publishPerfHandle(trace = readStoredTrace()) {
  if (typeof window === "undefined") {
    return
  }

  ;(window as typeof window & {
    __CODENOMAD_PERF__?: {
      getTrace: () => PerfTraceEntry[]
      getSummary: () => PerfSummary
      clear: () => void
      mark: (name: string, detail?: PerfDetail) => PerfTraceEntry
    }
  }).__CODENOMAD_PERF__ = {
    getTrace: () => getPerfTrace(),
    getSummary: () => summarizePerfTrace(trace),
    clear: () => clearPerfTrace(),
    mark: (name: string, detail?: PerfDetail) => markPerf(name, detail),
  }
}

export function clearPerfTrace() {
  persistTrace([])
}

export function beginPerfTrace(name: string, detail?: PerfDetail) {
  clearPerfTrace()
  return markPerf(name, detail)
}

export function markPerf(name: string, detail?: PerfDetail): PerfTraceEntry {
  const entry: PerfTraceEntry = {
    name,
    time: nowMs(),
    absoluteTime: absoluteNowMs(),
    host: runtimeEnv.host,
    platform: runtimeEnv.platform,
    path: getCurrentPath(),
    detail,
  }

  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    try {
      performance.mark(name)
    } catch {
      /* noop */
    }
  }

  persistTrace([...readStoredTrace(), entry])
  return entry
}

export function measurePerf(name: string, startMark: string, endMark: string) {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") {
    return undefined
  }

  try {
    return performance.measure(name, startMark, endMark)
  } catch {
    return undefined
  }
}
