import { Component, Show } from "solid-js"
import { Dialog } from "@kobalte/core"
import { X } from "lucide-solid"
import InstanceServiceStatus from "./instance-service-status"
import type { Instance } from "../types/instance"

interface LspSettingsModalProps {
  open: boolean
  onClose: () => void
  instance: Instance | null
}

const LspSettingsModal: Component<LspSettingsModalProps> = (props) => {
  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <Dialog.Content class="dialog-content dialog-content-md">
          <div class="dialog-header">
            <Dialog.Title class="dialog-title">LSP Servers</Dialog.Title>
            <Dialog.CloseButton class="dialog-close-button">
              <X size={16} />
            </Dialog.CloseButton>
          </div>
          <div class="dialog-body">
            <Show when={props.instance} fallback={<p class="text-muted text-sm">No instance connected.</p>}>
              <InstanceServiceStatus
                initialInstance={props.instance!}
                sections={["lsp"]}
                showSectionHeadings={false}
                class="space-y-2"
              />
            </Show>
          </div>
          <div class="dialog-footer">
            <button type="button" class="btn btn-secondary btn-sm" onClick={props.onClose}>
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export default LspSettingsModal
