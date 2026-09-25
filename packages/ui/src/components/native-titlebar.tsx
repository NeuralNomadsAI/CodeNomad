import { Maximize2, Minus, X } from "lucide-solid"
import { For, Show, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { runNativeWindowAction, showNativeTitlebarMenu, startNativeWindowDrag, type NativeTitlebarMenu } from "../lib/native/window-controls"

interface NativeTitlebarProps {
  title: string
  menus?: boolean
  onClose?: () => void | Promise<void>
}

const menus: NativeTitlebarMenu[] = ["file", "edit", "view", "window", "help"]

export const NativeTitlebar: Component<NativeTitlebarProps> = (props) => {
  const { t } = useI18n()
  const close = () => props.onClose ? props.onClose() : runNativeWindowAction("close")

  return (
    <header
      class="native-titlebar"
      onPointerDown={(event) => {
        if (event.button === 0 && !(event.target as Element).closest("[data-titlebar-interactive]")) void startNativeWindowDrag()
      }}
      onDblClick={(event) => {
        if (!(event.target as Element).closest("[data-titlebar-interactive]")) void runNativeWindowAction("maximize")
      }}
    >
      <div class="native-titlebar-brand">
        <span class="native-titlebar-title">{props.title}</span>
      </div>
      <Show when={props.menus}>
        <nav class="native-titlebar-menu" aria-label={t("window.menu.ariaLabel")} data-titlebar-interactive>
          <For each={menus}>{(menu) => (
            <button
              type="button"
              class="native-titlebar-menu-button"
              onClick={(event) => void showNativeTitlebarMenu(menu, event.currentTarget)}
            >
              {t(`window.menu.${menu}`)}
            </button>
          )}</For>
        </nav>
      </Show>
      <div class="native-titlebar-drag-region" />
      <div class="native-titlebar-controls">
        <button type="button" class="native-titlebar-button" data-titlebar-interactive onClick={() => void runNativeWindowAction("minimize")} aria-label={t("window.controls.minimize")} title={t("window.controls.minimize")}>
          <Minus aria-hidden="true" />
        </button>
        <button type="button" class="native-titlebar-button" data-titlebar-interactive onClick={() => void runNativeWindowAction("maximize")} aria-label={t("window.controls.maximize")} title={t("window.controls.maximize")}>
          <Maximize2 aria-hidden="true" />
        </button>
        <button type="button" class="native-titlebar-button native-titlebar-close" data-titlebar-interactive onClick={() => void close()} aria-label={t("window.controls.close")} title={t("window.controls.close")}>
          <X aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
