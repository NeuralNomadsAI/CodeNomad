import { createSignal } from "solid-js"

export interface StreamingMetrics {
  requestSentAt: number
  firstTokenAt: number | null
  estimatedOutputTokens: number
  lastSeenTextLength: number
  lastDeltaAt: number | null
  completedOutputTokens: number | null
  completedAt: number | null
}

function createEmptyMetrics(requestSentAt: number): StreamingMetrics {
  return {
    requestSentAt,
    firstTokenAt: null,
    estimatedOutputTokens: 0,
    lastSeenTextLength: 0,
    lastDeltaAt: null,
    completedOutputTokens: null,
    completedAt: null,
  }
}

function makeKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

const metricsMap = new Map<string, StreamingMetrics>()
const [metricsVersion, setMetricsVersion] = createSignal(0)

// Rolling average state — persists across requests within a session
const ROLLING_WINDOW_CAP = 30
const rollingRateSamples = new Map<string, number[]>()
const lastRateSample = new Map<string, { at: number; tokens: number }>()

function bump(): void {
  setMetricsVersion((n) => n + 1)
}

export function setRequestSent(instanceId: string, sessionId: string): void {
  const key = makeKey(instanceId, sessionId)
  metricsMap.set(key, createEmptyMetrics(Date.now()))
  // Reset per-request sample tracking but preserve rolling buffer across requests
  lastRateSample.delete(key)
  bump()
}

export function recordFirstToken(instanceId: string, sessionId: string): void {
  const key = makeKey(instanceId, sessionId)
  const m = metricsMap.get(key)
  if (!m || m.firstTokenAt !== null) return
  m.firstTokenAt = Date.now()
  bump()
}

export function addDeltaChars(instanceId: string, sessionId: string, totalTextLength: number): void {
  const key = makeKey(instanceId, sessionId)
  const m = metricsMap.get(key)
  if (!m) return
  const delta = totalTextLength - m.lastSeenTextLength
  if (delta > 0) {
    m.estimatedOutputTokens += Math.ceil(delta / 4)
    m.lastSeenTextLength = totalTextLength
    m.lastDeltaAt = Date.now()
    bump()
  }
}

export function setCompleted(instanceId: string, sessionId: string, outputTokens: number, completedAt: number): void {
  const key = makeKey(instanceId, sessionId)
  const m = metricsMap.get(key)
  if (!m) return
  m.completedOutputTokens = outputTokens
  m.completedAt = completedAt
  // Push the completed request's overall rate into the rolling buffer
  if (m.requestSentAt && outputTokens > 0) {
    const duration = (completedAt - m.requestSentAt) / 1000
    if (duration > 0) {
      const rate = Math.round(outputTokens / duration)
      const samples = rollingRateSamples.get(key) ?? []
      samples.push(rate)
      while (samples.length > ROLLING_WINDOW_CAP) samples.shift()
      rollingRateSamples.set(key, samples)
    }
  }
  lastRateSample.delete(key)
  bump()
}

export function clearMetrics(instanceId: string, sessionId: string): void {
  const key = makeKey(instanceId, sessionId)
  metricsMap.delete(key)
  rollingRateSamples.delete(key)
  lastRateSample.delete(key)
  bump()
}

/** Call once per tick (~1s) during active streaming to sample the current rate */
export function sampleCurrentRate(instanceId: string, sessionId: string): void {
  const key = makeKey(instanceId, sessionId)
  const m = metricsMap.get(key)
  if (!m || !m.firstTokenAt || m.completedAt) return

  const now = Date.now()
  const currentTokens = m.estimatedOutputTokens
  const last = lastRateSample.get(key)

  if (!last) {
    // First sample — seed baseline, no rate to push yet
    lastRateSample.set(key, { at: now, tokens: currentTokens })
    return
  }

  const dt = (now - last.at) / 1000
  if (dt < 0.5) return

  const dTokens = currentTokens - last.tokens
  const rate = dTokens > 0 ? Math.round(dTokens / dt) : 0

  const samples = rollingRateSamples.get(key) ?? []
  samples.push(rate)
  while (samples.length > ROLLING_WINDOW_CAP) samples.shift()
  rollingRateSamples.set(key, samples)

  lastRateSample.set(key, { at: now, tokens: currentTokens })
  bump()
}

/** Get the capped rolling average tok/s for a session */
export function getRollingTokPerSec(instanceId: string, sessionId: string): number | null {
  metricsVersion()
  const key = makeKey(instanceId, sessionId)
  const samples = rollingRateSamples.get(key)
  if (!samples || samples.length === 0) return null
  const sum = samples.reduce((a, b) => a + b, 0)
  return Math.round(sum / samples.length)
}

export function getStreamingMetrics(instanceId: string, sessionId: string): StreamingMetrics | undefined {
  // Subscribe to version signal so callers react to updates
  metricsVersion()
  const key = makeKey(instanceId, sessionId)
  return metricsMap.get(key)
}
