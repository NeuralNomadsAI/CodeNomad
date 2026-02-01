import { Component, For } from "solid-js"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui"
import { ScrollArea } from "./ui"
import Kbd from "./kbd"

interface ShortcutItem {
  keys: string
  description: string
}

interface ShortcutCategory {
  title: string
  shortcuts: ShortcutItem[]
}

const shortcutCategories: ShortcutCategory[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: "cmd+shift+[", description: "Previous session" },
      { keys: "cmd+shift+]", description: "Next session" },
      { keys: "cmd+[", description: "Previous instance" },
      { keys: "cmd+]", description: "Next instance" },
      { keys: "cmd+1-9", description: "Switch to instance N" },
      { keys: "cmd+shift+1-9", description: "Switch to session N" },
    ],
  },
  {
    title: "Sessions & Instances",
    shortcuts: [
      { keys: "cmd+n", description: "New instance" },
      { keys: "cmd+shift+n", description: "New session" },
      { keys: "cmd+w", description: "Close instance" },
      { keys: "cmd+shift+w", description: "Close session" },
      { keys: "cmd+shift+l", description: "Instance info" },
    ],
  },
  {
    title: "Agent & Model",
    shortcuts: [
      { keys: "cmd+shift+a", description: "Select agent" },
      { keys: "cmd+shift+m", description: "Select model" },
    ],
  },
  {
    title: "Input",
    shortcuts: [
      { keys: "enter", description: "New line" },
      { keys: "cmd+enter", description: "Send message" },
      { keys: "@", description: "Attach files or agents" },
      { keys: "up", description: "Previous prompt in history" },
      { keys: "down", description: "Next prompt in history" },
      { keys: "!", description: "Enter shell mode" },
      { keys: "esc", description: "Exit shell mode / Close dialogs" },
    ],
  },
  {
    title: "General",
    shortcuts: [
      { keys: "cmd+shift+p", description: "Command palette" },
    ],
  },
]

interface ShortcutsDialogProps {
  open: boolean
  onClose: () => void
}

const ShortcutsDialog: Component<ShortcutsDialogProps> = (props) => {
  return (
    <Dialog open={props.open} onOpenChange={(isOpen) => !isOpen && props.onClose()}>
      <DialogContent class="max-w-lg max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>

        <ScrollArea class="max-h-[60vh] pr-2">
          <div class="space-y-6">
            <For each={shortcutCategories}>
              {(category) => (
                <div class="space-y-2">
                  <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {category.title}
                  </h3>
                  <div class="space-y-1">
                    <For each={category.shortcuts}>
                      {(shortcut) => (
                        <div class="flex items-center justify-between py-1.5 px-1">
                          <span class="text-sm text-foreground">{shortcut.description}</span>
                          <Kbd shortcut={shortcut.keys} />
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

export default ShortcutsDialog
