import { Component, Show, createSignal } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, Shield, AlertTriangle } from "lucide-solid"
import { cn } from "../lib/cn"
import { Button } from "./ui"
import { setRuleOverride, type GovernanceRule } from "../stores/era-governance"

interface GovernanceOverrideDialogProps {
  open: boolean
  onClose: () => void
  rule: GovernanceRule | null
  folder: string
}

const GovernanceOverrideDialog: Component<GovernanceOverrideDialogProps> = (props) => {
  const [justification, setJustification] = createSignal("")
  const [isSubmitting, setIsSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const handleSubmit = async () => {
    if (!props.rule || !justification().trim()) {
      setError("Please provide a justification")
      return
    }

    setIsSubmitting(true)
    setError(null)

    const result = await setRuleOverride(
      props.rule.id,
      "allow",
      justification().trim(),
      props.folder
    )

    setIsSubmitting(false)

    if (result.success) {
      setJustification("")
      props.onClose()
    } else {
      setError(result.error || "Failed to set override")
    }
  }

  const handleClose = () => {
    setJustification("")
    setError(null)
    props.onClose()
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && handleClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class={cn("fixed inset-0 z-[55] bg-black/50")} />
        <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <Dialog.Content class={cn("w-full max-w-md rounded-lg shadow-2xl bg-background border border-border")}>
            <div class={cn("flex items-center justify-between px-4 py-3 border-b border-border")}>
              <Dialog.Title class={cn("flex items-center gap-2 text-lg font-semibold text-foreground")}>
                <Shield class="w-5 h-5" />
                <span>Override Rule</span>
              </Dialog.Title>
              <Dialog.CloseButton class={cn("p-1 rounded hover:bg-accent transition-colors text-muted-foreground")}>
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            <Show when={props.rule}>
              <div class={cn("p-4 space-y-4")}>
                <div class={cn("p-3 rounded-lg bg-secondary")}>
                  <div class={cn("font-mono text-sm font-medium mb-1 text-foreground")}>{props.rule!.id}</div>
                  <div class={cn("text-sm text-muted-foreground")}>{props.rule!.reason}</div>
                  <Show when={props.rule!.suggestion}>
                    <div class={cn("text-xs mt-2 pt-2 border-t border-border text-muted-foreground")}>
                      {props.rule!.suggestion}
                    </div>
                  </Show>
                </div>

                <div class={cn("flex items-start gap-2 p-3 rounded-lg text-sm bg-warning/10 text-warning")}>
                  <AlertTriangle class="w-4 h-4" />
                  <span>
                    Overriding this rule will allow the blocked command to execute.
                    Make sure you understand the implications.
                  </span>
                </div>

                <div class={cn("space-y-2")}>
                  <label class={cn("block text-sm font-medium text-foreground")}>
                    Justification <span class="text-destructive">*</span>
                  </label>
                  <textarea
                    class={cn(
                      "w-full px-3 py-2 rounded-md text-sm resize-none",
                      "bg-secondary border border-border text-foreground",
                      "placeholder:text-muted-foreground",
                      "focus:outline-none focus:border-info"
                    )}
                    placeholder="Explain why this override is necessary..."
                    value={justification()}
                    onInput={(e) => setJustification(e.currentTarget.value)}
                    rows={3}
                  />
                  <p class={cn("text-xs text-muted-foreground")}>
                    This justification will be saved to .era/governance.local.yaml
                  </p>
                </div>

                <Show when={error()}>
                  <div class={cn("flex items-center gap-2 p-3 rounded-lg text-sm bg-destructive/10 text-destructive")}>
                    <AlertTriangle class="w-4 h-4" />
                    <span>{error()}</span>
                  </div>
                </Show>
              </div>

              <div class={cn("flex items-center justify-end gap-2 px-4 py-3 border-t border-border")}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClose}
                  disabled={isSubmitting()}
                >
                  Cancel
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSubmit}
                  disabled={isSubmitting() || !justification().trim()}
                >
                  {isSubmitting() ? "Saving..." : "Allow Rule"}
                </Button>
              </div>
            </Show>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default GovernanceOverrideDialog
