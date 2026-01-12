import { Component, createSignal, Show } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { AlertTriangle, X } from "lucide-solid"

export type CloseTabType = "session" | "project"

interface CloseTabModalProps {
  open: boolean
  type: CloseTabType
  name: string
  sessionCount?: number // For project close, how many sessions will be affected
  onConfirm: (keepInBackground: boolean) => void
  onCancel: () => void
}

const CloseTabModal: Component<CloseTabModalProps> = (props) => {
  const [keepInBackground, setKeepInBackground] = createSignal(false)

  const title = () => {
    if (props.type === "session") {
      return "Close Session"
    }
    return "Close Project"
  }

  const description = () => {
    if (props.type === "session") {
      return `Are you sure you want to close "${props.name}"?`
    }
    const sessionText = props.sessionCount === 1 ? "1 session" : `${props.sessionCount || 0} sessions`
    return `Are you sure you want to close "${props.name}"? This will end ${sessionText}.`
  }

  const handleConfirm = () => {
    props.onConfirm(keepInBackground())
    setKeepInBackground(false)
  }

  const handleCancel = () => {
    props.onCancel()
    setKeepInBackground(false)
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && handleCancel()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="close-modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="close-modal">
            <div class="close-modal-header">
              <div class="close-modal-icon">
                <AlertTriangle class="w-5 h-5" />
              </div>
              <div class="close-modal-title-group">
                <Dialog.Title class="close-modal-title">{title()}</Dialog.Title>
                <Dialog.Description class="close-modal-description">
                  {description()}
                </Dialog.Description>
              </div>
              <Dialog.CloseButton class="close-modal-close" onClick={handleCancel}>
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            <div class="close-modal-body">
              <label class="close-modal-checkbox">
                <input
                  type="checkbox"
                  checked={keepInBackground()}
                  onChange={(e) => setKeepInBackground(e.currentTarget.checked)}
                />
                <span>Keep running in background for quick access later</span>
              </label>
            </div>

            <div class="close-modal-footer">
              <button
                type="button"
                class="close-modal-button close-modal-button-secondary"
                onClick={handleCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                class="close-modal-button close-modal-button-danger"
                onClick={handleConfirm}
              >
                {props.type === "session" ? "Close Session" : "Close Project"}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default CloseTabModal
