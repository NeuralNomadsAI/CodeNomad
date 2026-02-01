import { Component } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, Globe, FolderCog } from "lucide-solid"
import { cn } from "../lib/cn"
import { Button } from "./ui"
import type { McpServerConfig } from "../stores/preferences"

export interface AddToGlobalModalProps {
  open: boolean
  onClose: () => void
  type: "mcp" | "lsp"
  serverName: string
  serverConfig: McpServerConfig
  onAddGlobal: () => void
  onKeepProjectOnly: () => void
}

const AddToGlobalModal: Component<AddToGlobalModalProps> = (props) => {
  const typeLabel = () => (props.type === "mcp" ? "MCP Server" : "LSP Server")

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class={cn("fixed inset-0 z-50 bg-black/50")} />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class={cn("bg-background text-foreground rounded-lg shadow-2xl w-full max-w-md p-6 flex flex-col gap-4")}>
            <div class="flex items-start justify-between">
              <Dialog.Title class={cn("text-lg font-semibold text-foreground")}>
                Add {typeLabel()}
              </Dialog.Title>
              <Dialog.CloseButton class={cn("text-muted-foreground hover:text-foreground")}>
                <X class="w-5 h-5" />
              </Dialog.CloseButton>
            </div>

            <Dialog.Description class={cn("text-sm text-muted-foreground")}>
              Where would you like to add <strong>{props.serverName}</strong>?
            </Dialog.Description>

            <div class="flex flex-col gap-3">
              <button
                type="button"
                class={cn(
                  "flex items-center gap-3 p-3 rounded-lg text-left transition-colors",
                  "bg-secondary border border-border",
                  "hover:border-info hover:bg-accent"
                )}
                onClick={() => {
                  props.onAddGlobal()
                  props.onClose()
                }}
              >
                <div class={cn("flex items-center justify-center w-10 h-10 rounded-lg bg-info/10 text-info")}>
                  <Globe class="w-5 h-5" />
                </div>
                <div class="flex flex-col">
                  <span class={cn("text-sm font-medium text-foreground")}>Add to Global</span>
                  <span class={cn("text-xs text-muted-foreground")}>
                    Available in all projects and instances
                  </span>
                </div>
              </button>

              <button
                type="button"
                class={cn(
                  "flex items-center gap-3 p-3 rounded-lg text-left transition-colors",
                  "bg-secondary border border-border",
                  "hover:border-info hover:bg-accent"
                )}
                onClick={() => {
                  props.onKeepProjectOnly()
                  props.onClose()
                }}
              >
                <div class={cn("flex items-center justify-center w-10 h-10 rounded-lg bg-success/10 text-success")}>
                  <FolderCog class="w-5 h-5" />
                </div>
                <div class="flex flex-col">
                  <span class={cn("text-sm font-medium text-foreground")}>Keep Project Only</span>
                  <span class={cn("text-xs text-muted-foreground")}>
                    Only available in this project
                  </span>
                </div>
              </button>
            </div>

            <div class="flex justify-end pt-2">
              <Button variant="outline" size="sm" onClick={props.onClose}>
                Cancel
              </Button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default AddToGlobalModal
