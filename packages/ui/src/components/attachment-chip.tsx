import { Component } from "solid-js"
import type { Attachment } from "../types/attachment"

interface AttachmentChipProps {
  attachment: Attachment
  onRemove: () => void
}

const AttachmentChip: Component<AttachmentChipProps> = (props) => {
  return (
    <div
      class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium ring-1 ring-inset bg-info/10 text-info ring-info/10 rounded-md"
      title={props.attachment.source.type === "file" ? props.attachment.source.path : undefined}
    >
      <span class="font-mono">{props.attachment.display}</span>
      <button
        onClick={props.onRemove}
        class="ml-0.5 flex h-4 w-4 items-center justify-center rounded transition-colors hover:bg-info/10"
        aria-label="Remove attachment"
      >
        ×
      </button>
    </div>
  )
}

export default AttachmentChip
