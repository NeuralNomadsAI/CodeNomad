/**
 * Clipboard utility with fallback for non-secure contexts
 * The modern Clipboard API requires HTTPS or localhost, but document.execCommand
 * works in HTTP contexts as a fallback.
 */

import { getLogger } from "./logger"

const log = getLogger("actions")

/**
 * Copy text to clipboard with fallback for non-secure contexts
 * @param text - The text to copy
 * @returns Promise<boolean> - true if successful, false if failed
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    // Try modern Clipboard API first (requires secure context)
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      log.info("Copied text using Clipboard API")
      return true
    }
  } catch (error) {
    log.warn("Clipboard API failed, trying fallback:", error)
  }

  // Fallback for non-secure contexts (HTTP) using document.execCommand
  try {
    if (typeof document === "undefined") {
      log.error("Document not available for clipboard fallback")
      return false
    }

    // Create temporary textarea element
    const textArea = document.createElement("textarea")
    textArea.value = text
    textArea.style.position = "fixed"
    textArea.style.left = "-9999px"
    textArea.style.top = "-9999px"
    textArea.style.opacity = "0"

    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()

    const success = document.execCommand("copy")
    document.body.removeChild(textArea)

    if (success) {
      log.info("Copied text using execCommand fallback")
      return true
    } else {
      log.error("execCommand copy failed")
      return false
    }
  } catch (error) {
    log.error("Clipboard fallback failed:", error)
    return false
  }
}