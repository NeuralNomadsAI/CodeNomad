import { Component } from "solid-js"
import { cn } from "../lib/cn"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./ui"
import { Button } from "./ui"

export interface AddMcpServerResult {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface AddMcpServerModalProps {
  open: boolean
  onClose: () => void
  folder?: string
  instanceId?: string
  onApply?: (result: AddMcpServerResult) => void
  onApplyToAll?: (result: AddMcpServerResult) => void
}

const AddMcpServerModal: Component<AddMcpServerModalProps> = (props) => {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent class="max-w-[min(640px,calc(100vw-32px))] max-h-[calc(100vh-64px)] flex flex-col rounded-xl shadow-xl">
        <DialogHeader class="px-5 py-4 border-b border-border">
          <DialogTitle>Add MCP Server</DialogTitle>
        </DialogHeader>
        <div class="flex-1 overflow-y-auto p-5">
          <p class="text-muted-foreground text-sm">
            MCP server configuration coming soon.
          </p>
        </div>
        <DialogFooter class="px-5 py-3 border-t border-border">
          <Button variant="secondary" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default AddMcpServerModal
