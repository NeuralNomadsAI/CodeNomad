import { showConfirmDialog, type AlertDialogState } from "../stores/alerts"

/** Install, host install and remove confirmations enable their action this long after they are shown. */
export const INTEGRATION_CONFIRM_DELAY_MS = 600

let claimed = false

/**
 * Reserves the single open integration or plugin-source confirmation. `undefined` while another one is open: the
 * new request shows nothing and sends nothing. The release is idempotent.
 */
function claimIntegrationConfirmation(): (() => void) | undefined {
  if (claimed) return undefined
  claimed = true
  let released = false
  return () => {
    if (released) return
    released = true
    claimed = false
  }
}

/**
 * The shared guarded confirmation: Cancel first and focused, the action enabled after
 * `INTEGRATION_CONFIRM_DELAY_MS`, one at a time. Cancel, Escape, closing, expiry or `signal` resolve false.
 */
export async function confirmIntegrationAction(message: string, options: Omit<AlertDialogState, "message" | "type" | "confirmDelayMs">,
  signal?: AbortSignal): Promise<boolean> {
  const release = claimIntegrationConfirmation()
  if (!release) return false
  try {
    return await showConfirmDialog(message, { ...options, confirmDelayMs: INTEGRATION_CONFIRM_DELAY_MS }, signal)
  } finally {
    release()
  }
}
