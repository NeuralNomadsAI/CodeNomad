import { Maximize2, Minus, X } from "lucide-solid"
import { For, Show, onCleanup, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { isMac } from "../lib/keyboard-utils"
import { runtimeEnv } from "../lib/runtime-env"
import { runNativeWindowAction, showNativeTitlebarMenu, startNativeWindowDrag, type NativeTitlebarMenu } from "../lib/native/window-controls"
import AppActions from "./app-actions"

interface NativeTitlebarProps {
  title: string
  /** Show the CodeNomad mark instead of the title text; the title remains its accessible name. */
  logo?: boolean
  menus?: boolean
  /** Hold the app actions on macOS (see `appActionsInTitlebar`). */
  actions?: boolean
  onClose?: () => void | Promise<void>
}

const menus: NativeTitlebarMenu[] = ["file", "edit", "view", "window", "help"]
const codeNomadMark = new URL("../images/CodeNomad-Mark.svg", import.meta.url).href
// macOS keeps the menus in its global menu bar and the window controls in the native
// traffic lights, which the host places over the left end of this bar.
const macOS = isMac()

/** Local desktop application windows draw this title bar instead of a native one. */
export const hasNativeTitlebar = runtimeEnv.windowContext === "local" && runtimeEnv.host !== "web"
/** On macOS the main window's title bar, otherwise empty, holds the app actions instead of the project tab bar. */
export const appActionsInTitlebar = hasNativeTitlebar && macOS

/**
 * The traffic lights never zoom, so the macOS bar undoes the host's page zoom from
 * `--host-page-zoom`/`--host-page-unzoom`. Tauri's WebKit hides the zoom, so its host
 * publishes them (`title_bar.rs`); Chromium's is the window's width over the page's.
 */
function publishElectronPageZoom() {
  const update = () => {
    const ratio = window.outerWidth / window.innerWidth
    const zoom = Number.isFinite(ratio) && ratio > 0.2 && ratio < 5 ? Math.round(ratio * 100) / 100 : 1
    document.documentElement.style.setProperty("--host-page-zoom", String(zoom))
    document.documentElement.style.setProperty("--host-page-unzoom", String(1 / zoom))
  }
  update()
  window.addEventListener("resize", update)
  onCleanup(() => window.removeEventListener("resize", update))
}

export const NativeTitlebar: Component<NativeTitlebarProps> = (props) => {
  const { t } = useI18n()
  const close = () => props.onClose ? props.onClose() : runNativeWindowAction("close")
  if (macOS && runtimeEnv.host === "electron") publishElectronPageZoom()

  return (
    <header
      class="native-titlebar"
      classList={{ "native-titlebar--macos": macOS }}
      onPointerDown={(event) => {
        if (event.button === 0 && !(event.target as Element).closest("[data-titlebar-interactive]")) void startNativeWindowDrag()
      }}
      onDblClick={(event) => {
        if (!(event.target as Element).closest("[data-titlebar-interactive]")) void runNativeWindowAction("maximize")
      }}
    >
      <div class="native-titlebar-brand">
        <Show when={props.logo} fallback={<span class="native-titlebar-title">{props.title}</span>}>
          <img src={codeNomadMark} alt={props.title} class="native-titlebar-logo" draggable={false} />
        </Show>
      </div>
      <Show when={props.menus && !macOS}>
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
      <Show when={props.actions && macOS}>
        <AppActions class="native-titlebar-actions" />
      </Show>
      <Show when={!macOS}>
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
      </Show>
    </header>
  )
}
