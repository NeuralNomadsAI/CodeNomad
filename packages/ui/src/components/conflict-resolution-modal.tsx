import { Component, createSignal, Show } from "solid-js"
import { AlertTriangle, X, RefreshCw, Upload, Download } from "lucide-solid"
import type { ConflictInfo } from "../stores/era-directives"

export type ConflictResolution = "keep-local" | "keep-server" | "retry"

interface ConflictResolutionModalProps {
  open: boolean
  onClose: () => void
  onResolve: (resolution: ConflictResolution) => void
  filePath: string
  localContent: string
  conflictInfo: ConflictInfo
  fileType: string // e.g., "directives", "governance", "mcp"
}

/**
 * Modal for resolving file conflicts when concurrent modifications are detected
 */
const ConflictResolutionModal: Component<ConflictResolutionModalProps> = (props) => {
  const [isResolving, setIsResolving] = createSignal(false)

  const handleResolve = async (resolution: ConflictResolution) => {
    setIsResolving(true)
    try {
      props.onResolve(resolution)
    } finally {
      setIsResolving(false)
    }
  }

  const formatTimestamp = (timestamp: number | null) => {
    if (!timestamp) return "unknown time"
    const date = new Date(timestamp)
    return date.toLocaleString()
  }

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={() => props.onClose()}>
        <div class="modal-content conflict-modal" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div class="modal-header conflict-modal-header">
            <div class="conflict-modal-title">
              <AlertTriangle class="w-6 h-6 text-amber-500" />
              <h2>File Conflict Detected</h2>
            </div>
            <button
              type="button"
              class="modal-close-btn"
              onClick={() => props.onClose()}
              aria-label="Close"
            >
              <X class="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div class="modal-body conflict-modal-body">
            <p class="conflict-modal-description">
              The {props.fileType} file has been modified by another session while you were editing.
              Your changes cannot be saved without overwriting the other changes.
            </p>

            <div class="conflict-modal-details">
              <div class="conflict-detail-row">
                <span class="conflict-detail-label">File:</span>
                <span class="conflict-detail-value">{props.filePath}</span>
              </div>
              <Show when={props.conflictInfo.lastModifiedBy}>
                <div class="conflict-detail-row">
                  <span class="conflict-detail-label">Modified by:</span>
                  <span class="conflict-detail-value">{props.conflictInfo.lastModifiedBy}</span>
                </div>
              </Show>
              <Show when={props.conflictInfo.lastModifiedAt}>
                <div class="conflict-detail-row">
                  <span class="conflict-detail-label">Modified at:</span>
                  <span class="conflict-detail-value">
                    {formatTimestamp(props.conflictInfo.lastModifiedAt)}
                  </span>
                </div>
              </Show>
            </div>

            <div class="conflict-modal-options">
              <h3>Choose how to resolve:</h3>

              <button
                type="button"
                class="conflict-option-btn conflict-option-local"
                onClick={() => handleResolve("keep-local")}
                disabled={isResolving()}
              >
                <Upload class="w-5 h-5" />
                <div class="conflict-option-text">
                  <span class="conflict-option-title">Keep My Changes</span>
                  <span class="conflict-option-desc">
                    Overwrite the server version with your local changes
                  </span>
                </div>
              </button>

              <button
                type="button"
                class="conflict-option-btn conflict-option-server"
                onClick={() => handleResolve("keep-server")}
                disabled={isResolving()}
              >
                <Download class="w-5 h-5" />
                <div class="conflict-option-text">
                  <span class="conflict-option-title">Discard My Changes</span>
                  <span class="conflict-option-desc">
                    Reload the server version and discard your local changes
                  </span>
                </div>
              </button>

              <button
                type="button"
                class="conflict-option-btn conflict-option-retry"
                onClick={() => handleResolve("retry")}
                disabled={isResolving()}
              >
                <RefreshCw class="w-5 h-5" />
                <div class="conflict-option-text">
                  <span class="conflict-option-title">Retry</span>
                  <span class="conflict-option-desc">
                    Refresh and try saving again (useful if conflict was resolved)
                  </span>
                </div>
              </button>
            </div>
          </div>

          {/* Footer */}
          <div class="modal-footer conflict-modal-footer">
            <button
              type="button"
              class="btn btn-secondary"
              onClick={() => props.onClose()}
              disabled={isResolving()}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default ConflictResolutionModal
