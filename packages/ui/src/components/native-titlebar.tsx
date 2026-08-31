import { Maximize2, Minus, X } from "lucide-solid"
import { type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { runNativeWindowAction, startNativeWindowDrag } from "../lib/native/window-controls"

interface NativeTitlebarProps {
  title: string
  onClose?: () => void | Promise<void>
}

export const NativeTitlebar: Component<NativeTitlebarProps> = (props) => {
  const { t } = useI18n()
  const close = () => props.onClose ? props.onClose() : runNativeWindowAction("close")

  return (
    <header
      class="native-titlebar"
      onPointerDown={(event) => {
        if (event.button === 0 && !(event.target as Element).closest("button")) void startNativeWindowDrag()
      }}
      onDblClick={(event) => {
        if (!(event.target as Element).closest("button")) void runNativeWindowAction("maximize")
      }}
    >
      <div class="native-titlebar-drag-region">
        <span class="native-titlebar-title">{props.title}</span>
      </div>
      <div class="native-titlebar-controls">
        <button type="button" class="native-titlebar-button" onClick={() => void runNativeWindowAction("minimize")} aria-label={t("window.controls.minimize")} title={t("window.controls.minimize")}>
          <Minus aria-hidden="true" />
        </button>
        <button type="button" class="native-titlebar-button" onClick={() => void runNativeWindowAction("maximize")} aria-label={t("window.controls.maximize")} title={t("window.controls.maximize")}>
          <Maximize2 aria-hidden="true" />
        </button>
        <button type="button" class="native-titlebar-button native-titlebar-close" onClick={() => void close()} aria-label={t("window.controls.close")} title={t("window.controls.close")}>
          <X aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
