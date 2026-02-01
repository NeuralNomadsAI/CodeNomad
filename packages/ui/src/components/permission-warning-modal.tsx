import { Component } from "solid-js"
import { AlertTriangle, ShieldCheck, ShieldOff } from "lucide-solid"
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

interface PermissionWarningModalProps {
  open: boolean
  projectName: string
  onProceed: () => void
  onDisable: () => void
}

const PermissionWarningModal: Component<PermissionWarningModalProps> = (props) => {
  const handleProceed = () => {
    props.onProceed()
  }

  const handleDisable = () => {
    props.onDisable()
  }

  // Dismiss (X/ESC) = implicit consent, proceed with auto-approve
  const handleDismiss = () => {
    props.onProceed()
  }

  return (
    <AlertDialog open={props.open} onOpenChange={(open) => !open && handleDismiss()}>
      <AlertDialogContent class="max-w-md">
        <AlertDialogHeader>
          <div class="flex items-start gap-3">
            <div class={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
              "bg-warning/10 text-warning"
            )}>
              <AlertTriangle class="h-6 w-6" />
            </div>
            <div class="flex-1">
              <AlertDialogTitle>Auto-approve is enabled</AlertDialogTitle>
              <AlertDialogDescription class="mt-1">
                Opening "{props.projectName}"
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <div class="space-y-3 text-sm text-muted-foreground">
          <p>
            This project will run with <strong class="text-foreground">auto-approve permissions</strong> enabled, which means:
          </p>
          <ul class="list-disc pl-5 space-y-1">
            <li>File edits will be applied without confirmation</li>
            <li>Shell commands will execute without prompts</li>
            <li>Potentially destructive operations won't require approval</li>
          </ul>
          <p class="text-xs text-muted-foreground">
            You can change this at any time in the session sidebar or global settings.
          </p>
        </div>

        <AlertDialogFooter>
          <Button variant="outline" onClick={handleDisable}>
            <ShieldOff class="w-4 h-4 mr-1.5" />
            <span>Disable for this project</span>
          </Button>
          <Button onClick={handleProceed}>
            <ShieldCheck class="w-4 h-4 mr-1.5" />
            <span>Proceed with auto-approve</span>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default PermissionWarningModal
