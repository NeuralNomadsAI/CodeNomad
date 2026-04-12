import { Show, type Component } from "solid-js"
import { X } from "lucide-solid"
import { useI18n } from "../../lib/i18n"

interface ProgressBarProps {
  progress: number
  label?: string
  onCancel?: () => void
  showClose?: boolean
  onClose?: () => void
}

const ProgressBar: Component<ProgressBarProps> = (props) => {
  const { t } = useI18n()
  const isComplete = () => props.progress >= 100

  return (
    <div class="file-progress-bar px-3 py-2 border-b border-base flex items-center gap-3">
      <div class="file-progress-track flex-1 h-1 bg-secondary rounded-full overflow-hidden">
        <div
          class="file-progress-fill h-full bg-accent-primary transition-all duration-150 rounded-full"
          style={{ width: `${props.progress}%` }}
        />
      </div>
      <span class="text-[11px] text-secondary min-w-[40px] text-right">{Math.round(props.progress)}%</span>
      <Show when={props.label}>
        <span class="text-[11px] text-muted">{props.label}</span>
      </Show>
      <Show when={!isComplete() && props.onCancel}>
        <button
          type="button"
          class="inline-flex items-center justify-center w-7 h-7 rounded border border-base transition-colors hover:bg-hover"
          onClick={props.onCancel}
          title={t("fileViewer.actions.cancel")}
        >
          <X class="h-3 w-3" />
        </button>
      </Show>
      <Show when={isComplete() && props.showClose}>
        <button
          type="button"
          class="inline-flex items-center justify-center w-7 h-7 rounded border border-base transition-colors hover:bg-hover"
          onClick={props.onClose}
          title={t("fileViewer.actions.close")}
        >
          <X class="h-3 w-3" />
        </button>
      </Show>
    </div>
  )
}

export default ProgressBar
