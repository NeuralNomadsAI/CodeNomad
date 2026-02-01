/**
 * Instruction Capture Store
 *
 * Signal-based store for the capture card that appears when an instruction
 * is detected in user messages. Follows the question-store.ts pattern.
 */
import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"
import type {
  ClassificationResult,
  InstructionCategory,
  InstructionScope,
} from "../lib/instruction-classifier"
import { recordCardShown } from "../lib/instruction-classifier"

const log = getLogger("instruction-capture")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CaptureCardState {
  visible: boolean
  classification: ClassificationResult | null
  userEditedInstruction: string
  selectedScope: InstructionScope
  selectedCategory: InstructionCategory | null
  status: "pending" | "saving" | "saved" | "dismissed" | "error"
  errorMessage: string | null
}

const INITIAL_STATE: CaptureCardState = {
  visible: false,
  classification: null,
  userEditedInstruction: "",
  selectedScope: "project",
  selectedCategory: null,
  status: "pending",
  errorMessage: null,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const [captureCardState, setCaptureCardState] = createSignal<CaptureCardState>({ ...INITIAL_STATE })

// Auto-dismiss timer handle
let autoDismissTimer: ReturnType<typeof setTimeout> | null = null

const AUTO_DISMISS_MS = 15_000

function clearAutoDismissTimer() {
  if (autoDismissTimer !== null) {
    clearTimeout(autoDismissTimer)
    autoDismissTimer = null
  }
}

function startAutoDismissTimer() {
  clearAutoDismissTimer()
  autoDismissTimer = setTimeout(() => {
    dismissCard()
  }, AUTO_DISMISS_MS)
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function showCaptureCard(classification: ClassificationResult): void {
  log.info("Showing capture card", {
    category: classification.category,
    confidence: classification.confidence,
    scope: classification.suggestedScope,
  })

  clearAutoDismissTimer()

  setCaptureCardState({
    visible: true,
    classification,
    userEditedInstruction: classification.extractedInstruction,
    selectedScope: classification.suggestedScope,
    selectedCategory: classification.category,
    status: "pending",
    errorMessage: null,
  })

  recordCardShown()
  startAutoDismissTimer()
}

export function dismissCard(): void {
  clearAutoDismissTimer()

  setCaptureCardState((prev) => ({
    ...prev,
    visible: false,
    status: "dismissed",
  }))

  // Reset fully after the fade-out animation completes
  setTimeout(() => {
    setCaptureCardState({ ...INITIAL_STATE })
  }, 300)
}

export function updateEditedInstruction(text: string): void {
  clearAutoDismissTimer() // user is interacting — stop auto-dismiss
  setCaptureCardState((prev) => ({
    ...prev,
    userEditedInstruction: text,
  }))
}

export function updateSelectedScope(scope: InstructionScope): void {
  clearAutoDismissTimer()
  setCaptureCardState((prev) => ({
    ...prev,
    selectedScope: scope,
  }))
}

export function updateSelectedCategory(category: InstructionCategory): void {
  clearAutoDismissTimer()
  setCaptureCardState((prev) => ({
    ...prev,
    selectedCategory: category,
  }))
}

/**
 * Accept the instruction and persist it.
 *
 * @param persistFn — Async callback that actually writes the instruction.
 *                    The store doesn't know about the server; the caller
 *                    wires up the correct API call.
 */
export async function acceptInstruction(
  persistFn: (instruction: string, scope: InstructionScope, category: InstructionCategory | null) => Promise<void>,
): Promise<void> {
  clearAutoDismissTimer()

  const state = captureCardState()
  if (!state.visible || state.status === "saving") return

  setCaptureCardState((prev) => ({ ...prev, status: "saving", errorMessage: null }))

  try {
    await persistFn(
      state.userEditedInstruction,
      state.selectedScope,
      state.selectedCategory,
    )

    setCaptureCardState((prev) => ({ ...prev, status: "saved" }))

    log.info("Instruction saved", {
      scope: state.selectedScope,
      category: state.selectedCategory,
      instruction: state.userEditedInstruction.slice(0, 80),
    })

    // Auto-dismiss after showing "Saved" briefly
    setTimeout(() => {
      dismissCard()
    }, 1500)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save instruction"
    log.error("Failed to save instruction", { error: message })
    setCaptureCardState((prev) => ({
      ...prev,
      status: "error",
      errorMessage: message,
    }))
  }
}

// ---------------------------------------------------------------------------
// Reactive Getter
// ---------------------------------------------------------------------------

export function getCaptureCardState(): CaptureCardState {
  return captureCardState()
}

export { captureCardState }
