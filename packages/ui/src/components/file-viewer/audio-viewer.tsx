import { onCleanup } from "solid-js"
import type { Component } from "solid-js"
import type { FilePreviewerProps } from "./types"

const AudioViewer: Component<FilePreviewerProps> = (props) => {
  onCleanup(() => {
    if (props.blobUrl) {
      URL.revokeObjectURL(props.blobUrl)
    }
  })

  const fileName = props.path.split("/").pop() || props.path

  return (
    <div class="audio-viewer flex flex-col items-center justify-center h-full gap-4 p-6">
      <div class="text-lg">🎵</div>
      <div class="text-xs font-mono text-secondary">{fileName}</div>
      <audio controls src={props.blobUrl} class="w-full max-w-md" />
    </div>
  )
}

export default AudioViewer
