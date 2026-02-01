/**
 * Conflict Resolution Panel
 *
 * Full resolution UI with side-by-side diff view and merge options.
 * Supports auto-merge, keep-ours, keep-theirs, and manual editing.
 */

import { Show, For, createSignal, createEffect, createMemo, onMount } from "solid-js"
import {
  activeConflicts,
  activeConflictCount,
  selectedConflictId,
  selectConflict,
  resolveConflict,
  fetchConflictDetails,
  isLoading,
  type FileConflictEvent,
  type FileConflictRegion,
} from "../stores/file-conflicts"
import "../styles/panels/file-conflicts.css"

interface ConflictResolutionPanelProps {
  workspaceRoot: string
  sessionId: string
  onClose?: () => void
}

interface ConflictDetail {
  conflictId: string
  filePath: string
  absolutePath: string
  conflictType: string
  involvedSessions: Array<{
    sessionId: string
    instanceId: string
    hash: string
    timestamp: number
  }>
  mergeResult: {
    canAutoMerge: boolean
    mergedContent?: string
    conflicts?: FileConflictRegion[]
  }
  timestamp: number
  isBinary: boolean
  diff: {
    base: string
    ours: string
    theirs: string
    merged?: string
  }
}

export function ConflictResolutionPanel(props: ConflictResolutionPanelProps) {
  const [detail, setDetail] = createSignal<ConflictDetail | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [manualContent, setManualContent] = createSignal("")
  const [viewMode, setViewMode] = createSignal<"side-by-side" | "unified">("side-by-side")
  const [resolving, setResolving] = createSignal(false)

  // Load details when selected conflict changes
  createEffect(async () => {
    const conflictId = selectedConflictId()
    if (!conflictId) {
      setDetail(null)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const details = await fetchConflictDetails(conflictId, props.workspaceRoot)
      if (details) {
        setDetail(details)
        // Initialize manual content with merged or ours
        setManualContent(details.diff.merged || details.diff.ours || "")
      } else {
        setError("Failed to load conflict details")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  })

  // Auto-select first conflict if none selected
  createEffect(() => {
    if (!selectedConflictId() && activeConflictCount() > 0) {
      selectConflict(activeConflicts()[0].conflictId)
    }
  })

  const handleResolve = async (
    resolution: "auto-merged" | "keep-ours" | "keep-theirs" | "manual"
  ) => {
    const conflictId = selectedConflictId()
    if (!conflictId) return

    setResolving(true)
    setError(null)

    try {
      const result = await resolveConflict(
        conflictId,
        resolution,
        props.sessionId,
        props.workspaceRoot,
        resolution === "manual" ? manualContent() : undefined
      )

      if (!result.success) {
        setError(result.error || "Resolution failed")
      } else {
        // Move to next conflict or close
        const remaining = activeConflicts()
        if (remaining.length > 0) {
          selectConflict(remaining[0].conflictId)
        } else {
          props.onClose?.()
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setResolving(false)
    }
  }

  const currentDetail = () => detail()
  const canAutoMerge = createMemo(() => currentDetail()?.mergeResult.canAutoMerge ?? false)
  const isBinary = createMemo(() => currentDetail()?.isBinary ?? false)

  return (
    <div class="conflict-resolution-panel">
      <div class="conflict-resolution-header">
        <h2>Resolve File Conflicts</h2>
        <div class="conflict-count-badge">
          {activeConflictCount()} conflict{activeConflictCount() !== 1 ? "s" : ""}
        </div>
        <button class="close-btn" onClick={props.onClose} aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6 6L14 14M14 6L6 14" stroke="currentColor" stroke-width="2" />
          </svg>
        </button>
      </div>

      <div class="conflict-resolution-body">
        {/* Conflict List Sidebar */}
        <div class="conflict-sidebar">
          <div class="sidebar-header">Files</div>
          <div class="conflict-file-list">
            <For each={activeConflicts()}>
              {(conflict) => (
                <button
                  class="conflict-file-item"
                  classList={{
                    selected: selectedConflictId() === conflict.conflictId,
                    "can-auto-merge": conflict.mergeResult.canAutoMerge,
                  }}
                  onClick={() => selectConflict(conflict.conflictId)}
                >
                  <span class="file-icon">
                    <Show
                      when={conflict.mergeResult.canAutoMerge}
                      fallback={
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--color-error)">
                          <path d="M8 1.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V2a.5.5 0 0 1 .5-.5z" />
                          <path d="M8 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" />
                        </svg>
                      }
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--color-warning)">
                        <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" opacity="0.3" />
                        <path d="M6.5 7.5l2 2 4-4" stroke="currentColor" stroke-width="1.5" fill="none" />
                      </svg>
                    </Show>
                  </span>
                  <span class="file-name" title={conflict.filePath}>
                    {getFileName(conflict.filePath)}
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Main Content Area */}
        <div class="conflict-main">
          <Show
            when={!loading() && currentDetail()}
            fallback={
              <div class="conflict-loading">
                <Show when={loading()}>
                  <div class="w-8 h-8 border-2 border-border border-t-primary rounded-full animate-spin" />
                  <span>Loading conflict details...</span>
                </Show>
                <Show when={!loading() && !currentDetail()}>
                  <span>Select a conflict to view details</span>
                </Show>
              </div>
            }
          >
            {/* File Info Header */}
            <div class="conflict-file-header">
              <div class="file-info">
                <span class="file-path">{currentDetail()!.filePath}</span>
                <span class="conflict-type">
                  {currentDetail()!.conflictType === "concurrent-write"
                    ? "Concurrent Edit"
                    : currentDetail()!.conflictType === "external-change"
                    ? "External Change"
                    : "Merge Conflict"}
                </span>
              </div>
              <div class="view-toggle">
                <button
                  classList={{ active: viewMode() === "side-by-side" }}
                  onClick={() => setViewMode("side-by-side")}
                >
                  Side by Side
                </button>
                <button
                  classList={{ active: viewMode() === "unified" }}
                  onClick={() => setViewMode("unified")}
                >
                  Unified
                </button>
              </div>
            </div>

            {/* Error Display */}
            <Show when={error()}>
              <div class="conflict-error">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zM7 5a1 1 0 1 1 2 0v3a1 1 0 1 1-2 0V5zm1 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" />
                </svg>
                <span>{error()}</span>
              </div>
            </Show>

            {/* Binary File Notice */}
            <Show when={isBinary()}>
              <div class="binary-notice">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M4 4v12h12V4H4zm0-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
                  <path d="M6 8h8M6 12h4" stroke="currentColor" stroke-width="1.5" />
                </svg>
                <div>
                  <strong>Binary file cannot be merged</strong>
                  <p>Choose which version to keep</p>
                </div>
              </div>
            </Show>

            {/* Diff View */}
            <Show when={!isBinary()}>
              <div class="diff-container" classList={{ "side-by-side": viewMode() === "side-by-side" }}>
                <Show
                  when={viewMode() === "side-by-side"}
                  fallback={<UnifiedDiffView diff={currentDetail()!.diff} />}
                >
                  <SideBySideDiffView diff={currentDetail()!.diff} />
                </Show>
              </div>
            </Show>

            {/* Manual Editor (for text files with conflicts) */}
            <Show when={!isBinary() && !canAutoMerge()}>
              <div class="manual-editor">
                <div class="editor-header">
                  <span>Manual Resolution</span>
                  <button
                    class="reset-btn"
                    onClick={() => setManualContent(currentDetail()!.diff.ours || "")}
                  >
                    Reset to Ours
                  </button>
                </div>
                <textarea
                  class="editor-textarea"
                  value={manualContent()}
                  onInput={(e) => setManualContent(e.currentTarget.value)}
                  spellcheck={false}
                />
              </div>
            </Show>

            {/* Sessions Info */}
            <div class="sessions-info">
              <span class="sessions-label">Involved sessions:</span>
              <For each={currentDetail()!.involvedSessions}>
                {(session) => (
                  <span class="session-badge" title={`Hash: ${session.hash}`}>
                    {session.sessionId === "external" ? "External" : session.sessionId.slice(0, 8)}
                  </span>
                )}
              </For>
            </div>

            {/* Resolution Actions */}
            <div class="resolution-actions">
              <Show when={canAutoMerge() && !isBinary()}>
                <button
                  class="action-btn primary"
                  onClick={() => handleResolve("auto-merged")}
                  disabled={resolving()}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M13.5 3.5l-7 7-3-3" stroke="currentColor" stroke-width="2" fill="none" />
                  </svg>
                  {resolving() ? "Merging..." : "Auto-merge"}
                </button>
              </Show>

              <button
                class="action-btn"
                onClick={() => handleResolve("keep-ours")}
                disabled={resolving()}
              >
                Keep Ours
              </button>

              <button
                class="action-btn"
                onClick={() => handleResolve("keep-theirs")}
                disabled={resolving()}
              >
                Keep Theirs
              </button>

              <Show when={!isBinary() && !canAutoMerge()}>
                <button
                  class="action-btn primary"
                  onClick={() => handleResolve("manual")}
                  disabled={resolving()}
                >
                  {resolving() ? "Saving..." : "Save Manual Edit"}
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

// Side-by-side diff view component
function SideBySideDiffView(props: { diff: { base: string; ours: string; theirs: string; merged?: string } }) {
  return (
    <div class="side-by-side-diff">
      <div class="diff-pane ours">
        <div class="pane-header">Ours (Your Changes)</div>
        <pre class="diff-content">{props.diff.ours || "(empty)"}</pre>
      </div>
      <div class="diff-pane theirs">
        <div class="pane-header">Theirs (Other Changes)</div>
        <pre class="diff-content">{props.diff.theirs || "(empty)"}</pre>
      </div>
    </div>
  )
}

// Unified diff view component
function UnifiedDiffView(props: { diff: { base: string; ours: string; theirs: string; merged?: string } }) {
  const unifiedDiff = createMemo(() => {
    const oursLines = (props.diff.ours || "").split("\n")
    const theirsLines = (props.diff.theirs || "").split("\n")
    const result: Array<{ type: "same" | "ours" | "theirs"; content: string }> = []

    // Simple diff visualization
    const maxLines = Math.max(oursLines.length, theirsLines.length)
    for (let i = 0; i < maxLines; i++) {
      const oursLine = oursLines[i]
      const theirsLine = theirsLines[i]

      if (oursLine === theirsLine) {
        if (oursLine !== undefined) {
          result.push({ type: "same", content: oursLine })
        }
      } else {
        if (oursLine !== undefined) {
          result.push({ type: "ours", content: oursLine })
        }
        if (theirsLine !== undefined) {
          result.push({ type: "theirs", content: theirsLine })
        }
      }
    }

    return result
  })

  return (
    <div class="unified-diff">
      <pre class="diff-content">
        <For each={unifiedDiff()}>
          {(line) => (
            <div
              class="diff-line"
              classList={{
                same: line.type === "same",
                ours: line.type === "ours",
                theirs: line.type === "theirs",
              }}
            >
              <span class="line-marker">
                {line.type === "ours" ? "-" : line.type === "theirs" ? "+" : " "}
              </span>
              <span class="line-content">{line.content}</span>
            </div>
          )}
        </For>
      </pre>
    </div>
  )
}

// Helper to get file name from path
function getFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

// Modal wrapper for the resolution panel
interface ConflictResolutionModalProps extends ConflictResolutionPanelProps {
  isOpen: boolean
}

export function ConflictResolutionModal(props: ConflictResolutionModalProps) {
  return (
    <Show when={props.isOpen}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose?.()
      }}>
        <div class="conflict-modal-content">
          <ConflictResolutionPanel {...props} />
        </div>
      </div>
    </Show>
  )
}
