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
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-md">
            <div class="modal-header flex items-center justify-between">
              <Dialog.Title class="text-lg font-semibold text-primary">Google Cloud Authentication</Dialog.Title>
              <Dialog.CloseButton class="p-1 rounded hover:bg-white/10 transition-colors">
                <X size={16} />
              </Dialog.CloseButton>
            </div>
            <div class="modal-body">
              <p class="text-sm text-secondary">
                Google Cloud authentication is not yet available.
              </p>
              <p class="text-xs text-muted mt-2">
                This feature will enable Vertex AI integration, cloud infrastructure management,
                and other Google Cloud services. Check back in a future release.
              </p>
            </div>
            <div class="modal-footer">
              <button
                type="button"
                class="modal-button modal-button-secondary"
                onClick={props.onClose}
              >
                Close
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export default GCloudAuthModal
