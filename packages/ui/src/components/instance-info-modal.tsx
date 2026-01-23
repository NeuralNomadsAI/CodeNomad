import { Component, Show } from "solid-js"
import { Dialog } from "@kobalte/core"
import { X, RotateCcw, Square } from "lucide-solid"
import type { Instance } from "../types/instance"
import InstanceInfo from "./instance-info"

interface InstanceInfoModalProps {
  open: boolean
  onClose: () => void
  instance: Instance | null
  lspConnectedCount?: number
  onRestart?: () => void
  onStop?: () => void
}

const InstanceInfoModal: Component<InstanceInfoModalProps> = (props) => {
  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <Dialog.Content class="dialog-content dialog-content-md">
          <div class="dialog-header">
            <Dialog.Title class="dialog-title">Instance Details</Dialog.Title>
            <Dialog.CloseButton class="dialog-close-button">
              <X size={16} />
            </Dialog.CloseButton>
          </div>
          <div class="dialog-body">
            <Show when={props.instance} fallback={<div class="text-muted text-sm">No instance selected</div>}>
              {(instance) => (
                <div class="space-y-4">
                  <InstanceInfo instance={instance()} />
                  
                  <Show when={props.lspConnectedCount !== undefined}>
                    <div class="text-xs text-muted">
                      LSP Connections: {props.lspConnectedCount}
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </div>
          <div class="dialog-footer">
            <Show when={props.onStop}>
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                onClick={props.onStop}
              >
                <Square size={14} />
                <span>Stop</span>
              </button>
            </Show>
            <Show when={props.onRestart}>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                onClick={props.onRestart}
              >
                <RotateCcw size={14} />
                <span>Restart</span>
              </button>
            </Show>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export default InstanceInfoModal
