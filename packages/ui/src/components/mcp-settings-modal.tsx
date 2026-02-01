import { Component, Show } from "solid-js"
import { X } from "lucide-solid"
import InstanceMcpControl from "./instance-mcp-control"
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

interface McpSettingsModalProps {
  open: boolean
  onClose: () => void
  instance: Instance | null
}

const McpSettingsModal: Component<McpSettingsModalProps> = (props) => {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent class="max-w-[min(640px,calc(100vw-32px))] max-h-[calc(100vh-64px)] flex flex-col rounded-xl shadow-xl">
        <DialogHeader class="px-5 py-4 border-b border-border">
          <DialogTitle>MCP Servers</DialogTitle>
        </DialogHeader>
        <div class="flex-1 overflow-y-auto p-5">
          <Show when={props.instance} fallback={<p class="text-muted-foreground text-sm">No instance connected.</p>}>
            <InstanceMcpControl
              instance={props.instance!}
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

export default McpSettingsModal
