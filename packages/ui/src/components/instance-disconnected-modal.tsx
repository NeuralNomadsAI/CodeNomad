import { cn } from "../lib/cn"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "./ui"
import { Button } from "./ui"

interface InstanceDisconnectedModalProps {
  open: boolean
  folder?: string
  reason?: string
  onClose: () => void
}

export default function InstanceDisconnectedModal(props: InstanceDisconnectedModalProps) {
  const folderLabel = props.folder || "this workspace"
  const reasonLabel = props.reason || "The server stopped responding"

  return (
    <AlertDialog open={props.open}>
      <AlertDialogContent class="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle class="text-xl">Instance Disconnected</AlertDialogTitle>
          <AlertDialogDescription class="break-words">
            {folderLabel} can no longer be reached. Close the tab to continue working.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div class={cn(
          "rounded-lg border border-border bg-secondary p-4 text-sm text-muted-foreground"
        )}>
          <p class="font-medium text-foreground">Details</p>
          <p class="mt-2">{reasonLabel}</p>
          {props.folder && (
            <p class="mt-2">
              Folder: <span class="font-mono text-foreground break-all">{props.folder}</span>
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <Button onClick={props.onClose}>
            Close Instance
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
