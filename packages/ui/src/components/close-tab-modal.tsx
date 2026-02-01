import { Component, createSignal, Show } from "solid-js"
import { AlertTriangle } from "lucide-solid"
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
    <AlertDialog open={props.open} onOpenChange={(open) => !open && handleCancel()}>
      <AlertDialogContent class="max-w-md">
        <AlertDialogHeader>
          <div class="flex items-start gap-3">
            <div class={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
              "bg-warning/10 text-warning"
            )}>
              <AlertTriangle class="h-5 w-5" />
            </div>
            <div class="flex-1">
              <AlertDialogTitle>{title()}</AlertDialogTitle>
              <AlertDialogDescription class="mt-1">
                {description()}
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <div class="py-2">
          <label class="flex items-center gap-2 cursor-pointer text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={keepInBackground()}
              onChange={(e) => setKeepInBackground(e.currentTarget.checked)}
              class="rounded border-input"
            />
            <span>Keep running in background for quick access later</span>
          </label>
        </div>

        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
          >
            {props.type === "session" ? "Close Session" : "Close Project"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default CloseTabModal
