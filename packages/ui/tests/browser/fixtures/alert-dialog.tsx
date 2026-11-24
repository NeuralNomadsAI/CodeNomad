import { render } from "solid-js/web"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import AlertDialog from "../../../src/components/alert-dialog"
import { showAlertDialog, showChoiceDialog, showConfirmDialog, showPromptDialog } from "../../../src/stores/alerts"
import { initializeClientState } from "../../../src/stores/client-state"
import "../../../src/index.css"

void (async () => {
  await initializeClientState()
  render(() => <ConfigProvider><I18nProvider><ThemeProvider>
    <button type="button">Delete session</button>
    <AlertDialog />
  </ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
  ;(window as any).fixture = {
    confirm: () => {
      const w = window as any
      w.confirmResult = undefined
      void showConfirmDialog("Delete this session?", { title: "Delete session", variant: "warning", confirmLabel: "Delete", cancelLabel: "Keep" })
        .then(result => { w.confirmResult = result })
    },
    prompt: () => {
      const w = window as any
      w.confirmResult = undefined
      void showPromptDialog("Name this session", { title: "Rename session", confirmLabel: "Rename", cancelLabel: "Keep" })
        .then(result => { w.confirmResult = result })
    },
    choice: () => {
      const w = window as any
      w.confirmResult = undefined
      void showChoiceDialog("Save changes before closing?", [
        { value: "discard", label: "Discard", tone: "danger" },
        { value: "save", label: "Save", tone: "primary" },
      ], { title: "Unsaved changes", cancelLabel: "Keep" }).then(result => { w.confirmResult = result })
    },
    alert: () => showAlertDialog("The session was saved.", { title: "Saved", confirmLabel: "OK" }),
  }
})()
