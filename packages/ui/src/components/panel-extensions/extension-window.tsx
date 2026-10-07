import DismissibleWindow from "../dismissible-window"
import WindowCloseButton from "../window-close-button"
import { useI18n } from "../../lib/i18n"
import { ExtensionManager } from "./extension-manager"
import type { PanelExtensionsController } from "./use-panel-extensions"
import type { Accessor } from "solid-js"

export function ExtensionWindow(props: {
  id: string; instanceId: Accessor<string>; controller: PanelExtensionsController
  onClose: () => void; returnFocus: () => HTMLElement | undefined
}) {
  const { t } = useI18n()
  return <DismissibleWindow id={props.id} open onClose={props.onClose} returnFocus={props.returnFocus}
    title={t("panelExtensions.title")} class="panel-extension-window">
    <div class="window-header">
      <h2 class="window-title">{t("panelExtensions.title")}</h2>
      <WindowCloseButton label={t("window.controls.close")} onClose={props.onClose} />
    </div>
    <ExtensionManager instanceId={props.instanceId} controller={props.controller} />
  </DismissibleWindow>
}
