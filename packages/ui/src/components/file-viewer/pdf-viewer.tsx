import { onCleanup } from "solid-js"
import type { Component } from "solid-js"
import type { FilePreviewerProps } from "./types"
import { useI18n } from "../../lib/i18n"

const PDFViewer: Component<FilePreviewerProps> = (props) => {
  const { t } = useI18n()

  onCleanup(() => {
    if (props.blobUrl) {
      URL.revokeObjectURL(props.blobUrl)
    }
  })

  const handleDownload = () => {
    const a = document.createElement("a")
    a.href = props.blobUrl ?? ""
    a.download = props.path.split("/").pop() || "download.pdf"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <div class="pdf-viewer flex flex-col h-full">
      <div class="pdf-viewer-toolbar flex items-center gap-2 px-3 py-2 border-b border-base">
        <button
          type="button"
          class="text-[11px] px-2 py-1 rounded border border-base transition-colors"
          onClick={handleDownload}
        >
          {t("fileViewer.pdf.download")}
        </button>
      </div>
      <div class="pdf-viewer-content flex-1 min-h-0">
        <iframe
          src={props.blobUrl}
          class="w-full h-full border-0"
          title={props.path}
        />
      </div>
    </div>
  )
}

export default PDFViewer
