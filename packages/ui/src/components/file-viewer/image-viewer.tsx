import { createSignal, onCleanup } from "solid-js"
import type { Component } from "solid-js"
import type { FilePreviewerProps } from "./types"
import { useI18n } from "../../lib/i18n"

const ImageViewer: Component<FilePreviewerProps> = (props) => {
  const { t } = useI18n()
  const [zoom, setZoom] = createSignal(100)

  onCleanup(() => {
    if (props.blobUrl) {
      URL.revokeObjectURL(props.blobUrl)
    }
  })

  return (
    <div class="image-viewer flex flex-col h-full">
      <div class="image-viewer-toolbar flex items-center gap-2 px-3 py-2 border-b border-base">
        <button
          type="button"
          class="text-[11px] px-2 py-1 rounded border border-base transition-colors"
          onClick={() => setZoom(Math.max(25, zoom() - 25))}
          title={t("fileViewer.image.zoomOut")}
        >
          -
        </button>
        <span class="text-xs text-secondary min-w-[48px] text-center">{zoom()}%</span>
        <button
          type="button"
          class="text-[11px] px-2 py-1 rounded border border-base transition-colors"
          onClick={() => setZoom(Math.min(400, zoom() + 25))}
          title={t("fileViewer.image.zoomIn")}
        >
          +
        </button>
        <button
          type="button"
          class="text-[11px] px-2 py-1 rounded border border-base transition-colors"
          onClick={() => setZoom(100)}
          title={t("fileViewer.image.fit")}
        >
          {t("fileViewer.image.fit")}
        </button>
      </div>
      <div class="image-viewer-content flex-1 flex items-center justify-center overflow-auto min-h-0 p-4">
        <img
          src={props.blobUrl}
          alt={props.path}
          class="max-w-full transition-transform duration-150"
          style={{ transform: `scale(${zoom() / 100})` }}
        />
      </div>
    </div>
  )
}

export default ImageViewer
