import { onCleanup } from "solid-js"
import type { Component } from "solid-js"
import type { FilePreviewerProps } from "./types"

const VideoViewer: Component<FilePreviewerProps> = (props) => {
  onCleanup(() => {
    if (props.blobUrl) {
      URL.revokeObjectURL(props.blobUrl)
    }
  })

  return (
    <div class="video-viewer flex flex-col h-full">
      <div class="video-viewer-content flex-1 flex items-center justify-center overflow-auto min-h-0 p-4">
        <video controls src={props.blobUrl} class="max-w-full max-h-full" />
      </div>
    </div>
  )
}

export default VideoViewer
