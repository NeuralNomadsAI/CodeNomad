import { Component, Show, createEffect, createSignal } from "solid-js"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui"
import { Button } from "./ui"
import { Input } from "./ui"
import { Label } from "./ui"

interface SessionRenameDialogProps {
  open: boolean
  currentTitle: string
  sessionLabel?: string
  isSubmitting?: boolean
  onRename: (nextTitle: string) => Promise<void> | void
  onClose: () => void
}

const SessionRenameDialog: Component<SessionRenameDialogProps> = (props) => {
  const [title, setTitle] = createSignal("")
  const inputId = `session-rename-${Math.random().toString(36).slice(2)}`
  let inputRef: HTMLInputElement | undefined

  createEffect(() => {
    if (!props.open) return
    setTitle(props.currentTitle ?? "")
  })

  createEffect(() => {
    if (!props.open) return
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return
    window.requestAnimationFrame(() => {
      inputRef?.focus()
      inputRef?.select()
    })
  })

  const isSubmitting = () => Boolean(props.isSubmitting)
  const isRenameDisabled = () => isSubmitting() || !title().trim()

  async function handleRename(event?: Event) {
    event?.preventDefault()
    if (isRenameDisabled()) return
    await props.onRename(title().trim())
  }

  const description = () => {
    if (props.sessionLabel && props.sessionLabel.trim()) {
      return `Update the title for "${props.sessionLabel}".`
    }
    return "Set a new title for this session."
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !isSubmitting()) {
          props.onClose()
        }
      }}
    >
      <DialogContent class="max-w-sm" showClose={false}>
        <DialogHeader>
          <DialogTitle>Rename Session</DialogTitle>
          <DialogDescription>{description()}</DialogDescription>
        </DialogHeader>

        <form class="space-y-4" onSubmit={handleRename}>
          <div class="space-y-2">
            <Label for={inputId}>Session name</Label>
            <Input
              id={inputId}
              ref={(element: HTMLInputElement) => {
                inputRef = element
              }}
              type="text"
              value={title()}
              onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) => setTitle(event.currentTarget.value)}
              placeholder="Enter a session name"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!isSubmitting()) {
                  props.onClose()
                }
              }}
              disabled={isSubmitting()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isRenameDisabled()}
            >
              <Show
                when={!isSubmitting()}
                fallback={
                  <>
                    <svg class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                      <path
                        class="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    <span>Renaming...</span>
                  </>
                }
              >
                Rename
              </Show>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default SessionRenameDialog
