import type { Component } from "solid-js"

export interface FilePreviewerProps {
  path: string
  content: string
  blobUrl?: string
  mimeType?: string
  scopeKey: string
  isDark?: boolean
  onNavigate?: (path: string) => void
  onGetBlobUrl?: (filePath: string) => Promise<string | null>
  onSave?: (content: string) => void
  onContentChange?: (content: string) => void
  /** Markdown-only: initial view mode when controlled from header */
  initialViewMode?: "rendered" | "code"
}

export interface FilePreviewer {
  id: string
  canHandle: (path: string, mimeType?: string) => boolean
  priority: number
  component: Component<FilePreviewerProps>
}

export function selectPreviewer(previewers: FilePreviewer[], path: string, mimeType?: string): FilePreviewer {
  return previewers
    .filter((p) => p.canHandle(path, mimeType))
    .sort((a, b) => b.priority - a.priority)[0]
}
