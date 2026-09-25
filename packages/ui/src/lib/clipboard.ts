/**
 * Clipboard utility with fallback for non-secure contexts
 * The modern Clipboard API requires HTTPS or localhost, but document.execCommand
 * works in HTTP contexts as a fallback.
 */

import { getLogger } from "./logger"

const log = getLogger("actions")

export interface ClipboardCopyOptions {
  signal?: AbortSignal
  isCurrent?: () => boolean
}

function canCopy(options?: ClipboardCopyOptions): boolean {
  return !options?.signal?.aborted && options?.isCurrent?.() !== false
}

/**
 * Copy text to clipboard with fallback for non-secure contexts
 * @param text - The text to copy
 * @returns Promise<boolean> - true if successful, false if failed
 */
export async function copyToClipboard(text: string, options?: ClipboardCopyOptions): Promise<boolean> {
  if (!canCopy(options)) return false
  try {
    // Try modern Clipboard API first (requires secure context)
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      if (!canCopy(options)) return false
      await navigator.clipboard.writeText(text)
      log.info("Copied text using Clipboard API")
      return true
    }
  } catch (error) {
    if (!canCopy(options)) return false
    log.warn("Clipboard API failed, trying fallback:", error)
  }

  if (!canCopy(options)) return false
  // Fallback for non-secure contexts (HTTP) using document.execCommand
  let textArea: HTMLTextAreaElement | undefined
  const activeElement = typeof document !== "undefined" ? document.activeElement as HTMLElement | null : null
  try {
    if (typeof document === "undefined") {
      log.error("Document not available for clipboard fallback")
      return false
    }

    // Create temporary textarea element
    textArea = document.createElement("textarea")
    textArea.value = text
    textArea.readOnly = true
    textArea.style.position = "fixed"
    textArea.style.left = "-9999px"
    textArea.style.top = "-9999px"
    textArea.style.opacity = "0"

    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()

    // Focus/selection handlers can invalidate the owner synchronously too.
    if (!canCopy(options)) return false
    const success = document.execCommand("copy")
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
  } finally {
    try {
      textArea?.remove()
    } catch (error) {
      log.warn("Failed to remove clipboard fallback element:", error)
    }
    try {
      activeElement?.focus()
    } catch (error) {
      log.warn("Failed to restore focus after clipboard fallback:", error)
    }
  }
}

export async function copyTextChunksToClipboard(chunks: readonly string[], options?: ClipboardCopyOptions): Promise<boolean> {
  if (!canCopy(options)) return false
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      const item = new ClipboardItem({ "text/plain": new Blob([...chunks], { type: "text/plain" }) })
      if (!canCopy(options)) return false
      await navigator.clipboard.write([item])
      log.info("Copied text chunks using Clipboard API")
      return true
    }
  } catch (error) {
    if (!canCopy(options)) return false
    log.warn("Clipboard chunk write failed, trying text fallback:", error)
  }
  if (!canCopy(options)) return false
  return copyToClipboard(chunks.join(""), options)
}
