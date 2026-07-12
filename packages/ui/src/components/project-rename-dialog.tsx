import { Dialog } from "@kobalte/core/dialog"
import { Component, Show, createEffect, createSignal } from "solid-js"
import { useI18n } from "../lib/i18n"

interface ProjectRenameDialogProps {
  open: boolean
  currentName: string
  projectLabel?: string
  isSubmitting?: boolean
  onRename: (nextName: string) => Promise<void> | void
  onClose: () => void
}

const ProjectRenameDialog: Component<ProjectRenameDialogProps> = (props) => {
  const { t } = useI18n()
  const [name, setName] = createSignal("")
  const inputId = `project-rename-${Math.random().toString(36).slice(2)}`
  let inputRef: HTMLInputElement | undefined

  createEffect(() => {
    if (!props.open) return
    setName(props.currentName ?? "")
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
  const isRenameDisabled = () => isSubmitting() || !name().trim()

  async function handleRename(event?: Event) {
    event?.preventDefault()
    if (isRenameDisabled()) return
    await props.onRename(name().trim())
  }

  const description = () => {
    if (props.projectLabel && props.projectLabel.trim()) {
      return t("projectRenameDialog.description.withLabel", { label: props.projectLabel })
    }
    return t("projectRenameDialog.description.default")
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
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-sm p-6" tabIndex={-1}>
            <Dialog.Title class="text-lg font-semibold text-primary">{t("projectRenameDialog.title")}</Dialog.Title>
            <Dialog.Description class="text-sm text-secondary mt-1">
              {description()}
            </Dialog.Description>

            <form class="mt-4 space-y-4" onSubmit={handleRename}>
              <div class="space-y-2">
                <label class="text-sm font-medium text-secondary" for={inputId}>
                  {t("projectRenameDialog.input.label")}
                </label>
                <input
                  id={inputId}
                  ref={(element) => {
                    inputRef = element
                  }}
                  type="text"
                  dir="auto"
                  value={name()}
                  onInput={(event) => setName(event.currentTarget.value)}
                  placeholder={t("projectRenameDialog.input.placeholder")}
                  class="w-full px-3 py-2 text-sm bg-surface-base border border-base rounded text-primary focus-ring-accent"
                />
              </div>

              <div class="flex justify-end gap-3">
                <button
                  type="button"
                  class="button-tertiary"
                  onClick={() => {
                    if (!isSubmitting()) {
                      props.onClose()
                    }
                  }}
                  disabled={isSubmitting()}
                >
                  {t("projectRenameDialog.actions.cancel")}
                </button>
                <button
                  type="submit"
                  class="button-primary flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
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
                        <span>{t("projectRenameDialog.actions.renaming")}</span>
                      </>
                    }
                  >
                    {t("projectRenameDialog.actions.rename")}
                  </Show>
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default ProjectRenameDialog
