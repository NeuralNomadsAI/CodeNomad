import { Component, createSignal, Show } from "solid-js"
import { AlertTriangle, RefreshCw, Upload, Download } from "lucide-solid"
import type { ConflictInfo } from "../stores/era-directives"
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

export type ConflictResolution = "keep-local" | "keep-server" | "retry"

interface ConflictResolutionModalProps {
  open: boolean
  onClose: () => void
  onResolve: (resolution: ConflictResolution) => void
  filePath: string
  localContent: string
  conflictInfo: ConflictInfo
  fileType: string // e.g., "directives", "governance", "mcp"
}

/**
 * Modal for resolving file conflicts when concurrent modifications are detected
 */
const ConflictResolutionModal: Component<ConflictResolutionModalProps> = (props) => {
  const [isResolving, setIsResolving] = createSignal(false)

  const handleResolve = async (resolution: ConflictResolution) => {
    setIsResolving(true)
    try {
      props.onResolve(resolution)
    } finally {
      setIsResolving(false)
    }
  }

  const formatTimestamp = (timestamp: number | null) => {
    if (!timestamp) return "unknown time"
    const date = new Date(timestamp)
    return date.toLocaleString()
  }

  return (
    <AlertDialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <AlertDialogContent class="max-w-[500px]">
        <AlertDialogHeader>
          <div class="flex items-center gap-2">
            <AlertTriangle class="w-6 h-6 text-warning" />
            <AlertDialogTitle>File Conflict Detected</AlertDialogTitle>
          </div>
          <AlertDialogDescription>
            The {props.fileType} file has been modified by another session while you were editing.
            Your changes cannot be saved without overwriting the other changes.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Conflict details */}
        <div class="rounded-lg bg-secondary p-4 space-y-2">
          <div class="flex items-baseline gap-2 py-1 border-b border-border last:border-b-0">
            <span class="text-xs text-muted-foreground min-w-[80px]">File:</span>
            <span class="text-sm font-mono text-foreground break-all">{props.filePath}</span>
          </div>
          <Show when={props.conflictInfo.lastModifiedBy}>
            <div class="flex items-baseline gap-2 py-1 border-b border-border last:border-b-0">
              <span class="text-xs text-muted-foreground min-w-[80px]">Modified by:</span>
              <span class="text-sm font-mono text-foreground break-all">{props.conflictInfo.lastModifiedBy}</span>
            </div>
          </Show>
          <Show when={props.conflictInfo.lastModifiedAt}>
            <div class="flex items-baseline gap-2 py-1">
              <span class="text-xs text-muted-foreground min-w-[80px]">Modified at:</span>
              <span class="text-sm font-mono text-foreground break-all">
                {formatTimestamp(props.conflictInfo.lastModifiedAt)}
              </span>
            </div>
          </Show>
        </div>

        {/* Resolution options */}
        <div class="flex flex-col gap-2">
          <h3 class="text-sm font-medium text-muted-foreground mb-1">Choose how to resolve:</h3>

          <button
            type="button"
            class={cn(
              "flex items-start gap-3 p-3 rounded-lg border border-border bg-background",
              "text-left cursor-pointer transition-all duration-150",
              "hover:border-info hover:bg-secondary",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            onClick={() => handleResolve("keep-local")}
            disabled={isResolving()}
          >
            <Upload class="w-5 h-5 shrink-0 mt-0.5" />
            <div class="flex flex-col gap-0.5">
              <span class="text-sm font-medium text-foreground">Keep My Changes</span>
              <span class="text-xs text-muted-foreground">
                Overwrite the server version with your local changes
              </span>
            </div>
          </button>

          <button
            type="button"
            class={cn(
              "flex items-start gap-3 p-3 rounded-lg border border-border bg-background",
              "text-left cursor-pointer transition-all duration-150",
              "hover:border-warning hover:bg-secondary",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            onClick={() => handleResolve("keep-server")}
            disabled={isResolving()}
          >
            <Download class="w-5 h-5 shrink-0 mt-0.5" />
            <div class="flex flex-col gap-0.5">
              <span class="text-sm font-medium text-foreground">Discard My Changes</span>
              <span class="text-xs text-muted-foreground">
                Reload the server version and discard your local changes
              </span>
            </div>
          </button>

          <button
            type="button"
            class={cn(
              "flex items-start gap-3 p-3 rounded-lg border border-border bg-background",
              "text-left cursor-pointer transition-all duration-150",
              "hover:border-success hover:bg-secondary",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            onClick={() => handleResolve("retry")}
            disabled={isResolving()}
          >
            <RefreshCw class="w-5 h-5 shrink-0 mt-0.5" />
            <div class="flex flex-col gap-0.5">
              <span class="text-sm font-medium text-foreground">Retry</span>
              <span class="text-xs text-muted-foreground">
                Refresh and try saving again (useful if conflict was resolved)
              </span>
            </div>
          </button>
        </div>

        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => props.onClose()}
            disabled={isResolving()}
          >
            Cancel
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default ConflictResolutionModal
