/**
 * Dev-mode test injection hooks.
 *
 * Exposes window.__TEST_INJECT__ in development builds only,
 * enabling Playwright E2E tests to inject mock data (e.g., approach
 * evaluation metadata, pipeline states) without requiring a running
 * Era Code backend.
 *
 * Production builds strip this module entirely via dead code elimination.
 */

import {
  showCaptureCard,
  dismissCard,
  getCaptureCardState,
  type CaptureCardState,
} from "../stores/instruction-capture"
import {
  classify,
  regexPreFilter,
  mergeWithLlmResult,
  isLlmUnavailable,
  resetCooldown,
  recordCardShown,
  type ClassificationResult,
  type LlmClassifyResponse,
  type ClassifyConfirmResponse,
} from "./instruction-classifier"
import {
  retrieveSessionStartInstructions,
  retrieveToolInstructions,
  getComposedInjection,
  flushSession,
  clearRetrievalState,
  getRetrievalState,
} from "../stores/instruction-retrieval"

export interface TestInjectionHooks {
  /** Emit a custom event that components can listen for */
  emitTestEvent: (eventName: string, detail: unknown) => void
  /** Store arbitrary test data accessible via getTestData */
  setTestData: (key: string, value: unknown) => void
  /** Retrieve stored test data */
  getTestData: (key: string) => unknown

  // --- Instruction capture test hooks ---
  /** Show the instruction capture card with a classification result */
  showCaptureCard: (result: ClassificationResult) => void
  /** Dismiss the capture card */
  dismissCard: () => void
  /** Get current capture card state */
  getCaptureCardState: () => CaptureCardState
  /** Run the regex pre-filter on a message */
  regexPreFilter: (message: string) => ClassificationResult
  /** Run the full classification pipeline */
  classify: (message: string) => ClassificationResult | null
  /** Merge an LLM result with a regex result */
  mergeWithLlmResult: (regexResult: ClassificationResult, llmResult: LlmClassifyResponse) => ClassificationResult
  /** Check if an LLM response indicates unavailability */
  isLlmUnavailable: (resp: ClassifyConfirmResponse) => boolean
  /** Reset the classification cooldown timer */
  resetCooldown: () => void
  /** Record that a capture card was shown */
  recordCardShown: () => void

  // --- Instruction retrieval test hooks ---
  /** Retrieve session-start instructions from server */
  retrieveSessionStart: typeof retrieveSessionStartInstructions
  /** Retrieve tool-specific instructions from server */
  retrieveForTool: typeof retrieveToolInstructions
  /** Get composed injection markdown (one-shot) */
  getComposedInjection: typeof getComposedInjection
  /** Flush access counts and clear local state */
  flushSession: typeof flushSession
  /** Clear local retrieval state only */
  clearRetrievalState: typeof clearRetrievalState
  /** Raw signal accessor for retrieval state */
  getRetrievalState: typeof getRetrievalState
}

const testDataStore = new Map<string, unknown>()

const hooks: TestInjectionHooks = {
  emitTestEvent(eventName: string, detail: unknown) {
    window.dispatchEvent(new CustomEvent(`test:${eventName}`, { detail }))
  },
  setTestData(key: string, value: unknown) {
    testDataStore.set(key, value)
  },
  getTestData(key: string) {
    return testDataStore.get(key)
  },

  // Instruction capture hooks
  showCaptureCard,
  dismissCard,
  getCaptureCardState,
  regexPreFilter,
  classify,
  mergeWithLlmResult,
  isLlmUnavailable,
  resetCooldown,
  recordCardShown,

  // Instruction retrieval hooks
  retrieveSessionStart: retrieveSessionStartInstructions,
  retrieveForTool: retrieveToolInstructions,
  getComposedInjection,
  flushSession,
  clearRetrievalState,
  getRetrievalState,
}

/**
 * Initialize test injection hooks.
 * Only runs in development mode; no-op in production.
 */
export function initTestInjection(): void {
  if (import.meta.env.DEV) {
    ;(window as any).__TEST_INJECT__ = hooks
  }
}
