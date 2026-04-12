import { lazy, type Component } from "solid-js"
import type { FilePreviewer, FilePreviewerProps } from "./types"
import { isMarkdown, isImage, isAudio, isVideo, isPDF } from "../../lib/file-types"
import { selectPreviewer } from "./types"
export { selectPreviewer } from "./types"

const LazyMarkdownViewer = lazy(() => import("./markdown-viewer"))
const LazyImageViewer = lazy(() => import("./image-viewer"))
const LazyAudioViewer = lazy(() => import("./audio-viewer"))
const LazyVideoViewer = lazy(() => import("./video-viewer"))
const LazyPDFViewer = lazy(() => import("./pdf-viewer"))
const LazyMonacoFileViewer = lazy(() =>
  import("./monaco-file-viewer").then((module) => ({ default: module.MonacoFileViewer })),
)

export const filePreviewers: FilePreviewer[] = [
  { id: "markdown", canHandle: (path) => isMarkdown(path), priority: 100, component: LazyMarkdownViewer as Component<FilePreviewerProps> },
  { id: "image", canHandle: (path) => isImage(path), priority: 90, component: LazyImageViewer as Component<FilePreviewerProps> },
  { id: "audio", canHandle: (path) => isAudio(path), priority: 80, component: LazyAudioViewer as Component<FilePreviewerProps> },
  { id: "video", canHandle: (path) => isVideo(path), priority: 70, component: LazyVideoViewer as Component<FilePreviewerProps> },
  { id: "pdf", canHandle: (path) => isPDF(path), priority: 60, component: LazyPDFViewer as Component<FilePreviewerProps> },
  { id: "monaco", canHandle: () => true, priority: 0, component: LazyMonacoFileViewer as Component<FilePreviewerProps> },
]
