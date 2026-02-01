import { Component, Show } from "solid-js"
import { X } from "lucide-solid"
import InstanceServiceStatus from "./instance-service-status"
import type { Instance } from "../types/instance"
import { cn } from "../lib/cn"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from "./ui"
import { Button } from "./ui"

interface LspSettingsModalProps {
  open: boolean
  onClose: () => void
  instance: Instance | null
}

const LspSettingsModal: Component<LspSettingsModalProps> = (props) => {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent class="max-w-[min(640px,calc(100vw-32px))] max-h-[calc(100vh-64px)] flex flex-col rounded-xl shadow-xl">
        <DialogHeader class="px-5 py-4 border-b border-border">
          <DialogTitle>LSP Servers</DialogTitle>
        </DialogHeader>
        <div class="flex-1 overflow-y-auto p-5">
          <Show when={props.instance} fallback={<p class="text-muted-foreground text-sm">No instance connected.</p>}>
            <InstanceServiceStatus
              initialInstance={props.instance!}
              sections={["lsp"]}
              showSectionHeadings={false}
              class="space-y-2"
            />
          </Show>
        </div>
        <DialogFooter class="px-5 py-3 border-t border-border">
          <Button variant="secondary" size="sm" onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default LspSettingsModal
