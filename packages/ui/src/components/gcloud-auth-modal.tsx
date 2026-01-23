import { Component } from "solid-js"
import { Dialog } from "@kobalte/core"
import { X } from "lucide-solid"

interface GCloudAuthModalProps {
  open: boolean
  onClose: () => void
  mode?: "setup" | "expired" | "refresh"
}

const GCloudAuthModal: Component<GCloudAuthModalProps> = (props) => {
  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <Dialog.Content class="dialog-content dialog-content-md">
          <div class="dialog-header">
            <Dialog.Title class="dialog-title">Google Cloud Authentication</Dialog.Title>
            <Dialog.CloseButton class="dialog-close-button">
              <X size={16} />
            </Dialog.CloseButton>
          </div>
          <div class="dialog-body">
            <div class="text-muted text-sm">
              Google Cloud authentication coming soon.
            </div>
          </div>
          <div class="dialog-footer">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              onClick={props.onClose}
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export default GCloudAuthModal
