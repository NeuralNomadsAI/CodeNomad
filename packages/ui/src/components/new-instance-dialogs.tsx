import { Dialog } from "@kobalte/core/dialog"
import { createSignal, Show, type ComponentProps } from "solid-js"
import { Loader2 } from "lucide-solid"
import DirectoryBrowserDialog from "./directory-browser-dialog"
import { RemoteServerDialog } from "./remote-server-dialog"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { openNativeFolderDialog, supportsNativeDialogsInCurrentWindow } from "../lib/native/native-functions"

interface NewInstanceDialogsOptions {
  /** Starting folder for pickers, usually the most recent project. */
  defaultPath: () => string | undefined
  isLoading: () => boolean
  onSelectFolder: (path: string) => void
  /** Only the home page offers remote-server setup. */
  onSaveServer?: ComponentProps<typeof RemoteServerDialog>["onSubmit"]
}

/**
 * Browse and clone flows shared by the home page and the new-instance
 * launcher, plus optional home-page server setup. Mount `Dialogs` where it outlives the trigger.
 */
export function createNewInstanceDialogs(options: NewInstanceDialogsOptions) {
  const { t } = useI18n()
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = createSignal(false)
  const [isCloneDialogOpen, setIsCloneDialogOpen] = createSignal(false)
  const [isCloneDestinationBrowserOpen, setIsCloneDestinationBrowserOpen] = createSignal(false)
  const [cloneRepositoryUrl, setCloneRepositoryUrl] = createSignal("")
  const [cloneDestinationPath, setCloneDestinationPath] = createSignal("")
  const [cleanupCloneDestination, setCleanupCloneDestination] = createSignal(false)
  const [cloneDialogError, setCloneDialogError] = createSignal<string | null>(null)
  const [isCloningRepository, setIsCloningRepository] = createSignal(false)
  const [isServerDialogOpen, setIsServerDialogOpen] = createSignal(false)

  function resetCloneDialog() {
    setCloneRepositoryUrl("")
    setCloneDestinationPath("")
    setCleanupCloneDestination(false)
    setCloneDialogError(null)
  }

  function clone() {
    if (options.isLoading()) return
    resetCloneDialog()
    setIsCloneDialogOpen(true)
  }

  async function handleCloneRepository() {
    if (isCloningRepository()) return
    const repositoryUrl = cloneRepositoryUrl().trim()
    const destinationPath = cloneDestinationPath().trim()
    if (!repositoryUrl || !destinationPath) {
      setCloneDialogError(t("folderSelection.clone.dialog.errorRequired"))
      return
    }

    setIsCloningRepository(true)
    setCloneDialogError(null)
    try {
      const result = await serverApi.cloneWorkspaceRepository({
        repositoryUrl,
        destinationPath,
        cleanup: cleanupCloneDestination(),
      })
      setIsCloneDialogOpen(false)
      resetCloneDialog()
      if (!options.isLoading()) options.onSelectFolder(result.path)
    } catch (error) {
      setCloneDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsCloningRepository(false)
    }
  }

  async function browse() {
    if (options.isLoading()) return
    if (supportsNativeDialogsInCurrentWindow()) {
      const selected = await openNativeFolderDialog({
        title: t("folderSelection.dialog.title"),
        defaultPath: options.defaultPath(),
      })
      if (selected && !options.isLoading()) options.onSelectFolder(selected)
      return
    }
    setIsFolderBrowserOpen(true)
  }

  function handleBrowserSelect(path: string) {
    setIsFolderBrowserOpen(false)
    if (!options.isLoading()) options.onSelectFolder(path)
  }

  function handleCloneDestinationSelect(path: string) {
    setIsCloneDestinationBrowserOpen(false)
    setCloneDestinationPath(path)
    setIsCloneDialogOpen(true)
  }

  function handleCloneDestinationBrowserClose() {
    setIsCloneDestinationBrowserOpen(false)
    setIsCloneDialogOpen(true)
  }

  async function handleCloneDestinationBrowse() {
    if (isCloningRepository()) return

    const defaultPath = cloneDestinationPath() || options.defaultPath()
    if (supportsNativeDialogsInCurrentWindow()) {
      const selected = await openNativeFolderDialog({
        title: t("folderSelection.clone.destination.title"),
        defaultPath,
      })
      if (selected) {
        setCloneDestinationPath(selected)
      }
      return
    }

    setIsCloneDialogOpen(false)
    setIsCloneDestinationBrowserOpen(true)
  }

  const isOpen = () => isFolderBrowserOpen() || isCloneDialogOpen() || isCloneDestinationBrowserOpen() || isServerDialogOpen()

  function Dialogs() {
    return (
      <>
        <DirectoryBrowserDialog
          open={isFolderBrowserOpen()}
          title={t("folderSelection.dialog.title")}
          description={t("folderSelection.dialog.description")}
          initialPath={options.defaultPath()}
          onClose={() => setIsFolderBrowserOpen(false)}
          onSelect={handleBrowserSelect}
        />

        <DirectoryBrowserDialog
          open={isCloneDestinationBrowserOpen()}
          title={t("folderSelection.clone.destination.title")}
          description={t("folderSelection.clone.destination.description")}
          initialPath={cloneDestinationPath() || options.defaultPath()}
          onClose={handleCloneDestinationBrowserClose}
          onSelect={handleCloneDestinationSelect}
        />

        <Dialog open={isCloneDialogOpen()} onOpenChange={(open) => !open && setIsCloneDialogOpen(false)}>
          <Dialog.Portal>
            <Dialog.Overlay class="modal-overlay" />
            <div class="fixed inset-0 z-[1300] flex items-center justify-center p-4">
              <Dialog.Content
                class="modal-surface w-full max-w-lg p-6 flex flex-col gap-5"
                tabIndex={-1}
                onInteractOutside={(event) => {
                  if (isCloneDestinationBrowserOpen()) {
                    event.preventDefault()
                  }
                }}
                onEscapeKeyDown={(event) => {
                  if (isCloneDestinationBrowserOpen()) {
                    event.preventDefault()
                  }
                }}
              >
                <div>
                  <Dialog.Title class="text-xl font-semibold text-primary">
                    {t("folderSelection.clone.dialog.title")}
                  </Dialog.Title>
                  <Dialog.Description class="text-sm text-secondary mt-2">
                    {t("folderSelection.clone.dialog.description")}
                  </Dialog.Description>
                </div>

                <label class="flex flex-col gap-2 text-sm text-secondary">
                  <span>{t("folderSelection.clone.dialog.repositoryUrl")}</span>
                  <input
                    class="selector-input w-full"
                    value={cloneRepositoryUrl()}
                    onInput={(event) => setCloneRepositoryUrl(event.currentTarget.value)}
                    placeholder={t("folderSelection.clone.dialog.repositoryUrlPlaceholder")}
                    disabled={isCloningRepository()}
                  />
                </label>

                <label class="flex flex-col gap-2 text-sm text-secondary">
                  <span>{t("folderSelection.clone.dialog.destinationPath")}</span>
                  <div class="flex gap-2">
                    <input
                      class="selector-input w-full"
                      value={cloneDestinationPath()}
                      onInput={(event) => setCloneDestinationPath(event.currentTarget.value)}
                      placeholder={t("folderSelection.clone.dialog.destinationPathPlaceholder")}
                      disabled={isCloningRepository()}
                    />
                    <button
                      type="button"
                      class="selector-button selector-button-secondary w-auto px-4"
                      disabled={isCloningRepository()}
                      onClick={() => void handleCloneDestinationBrowse()}
                    >
                      {t("folderSelection.clone.dialog.browseDestination")}
                    </button>
                  </div>
                </label>

                <label class="flex items-start gap-3 text-sm text-secondary">
                  <input
                    type="checkbox"
                    checked={cleanupCloneDestination()}
                    disabled={isCloningRepository()}
                    onChange={(event) => setCleanupCloneDestination(event.currentTarget.checked)}
                  />
                  <span>{t("folderSelection.clone.dialog.cleanupDestination")}</span>
                </label>

                <Show when={cloneDialogError()}>
                  {(message) => <p class="text-sm text-red-500 break-words">{message()}</p>}
                </Show>

                <div class="flex items-center justify-end gap-3">
                  <button class="selector-button selector-button-secondary w-auto px-4" disabled={isCloningRepository()} onClick={() => setIsCloneDialogOpen(false)}>
                    {t("folderSelection.clone.dialog.cancel")}
                  </button>
                  <button
                    class="selector-button selector-button-primary w-auto px-4"
                    disabled={isCloningRepository()}
                    onClick={() => void handleCloneRepository()}
                  >
                    <Show when={isCloningRepository()} fallback={<span>{t("folderSelection.clone.dialog.clone")}</span>}>
                      <span class="inline-flex items-center gap-2">
                        <Loader2 class="w-4 h-4 animate-spin" />
                        {t("folderSelection.clone.dialog.cloning")}
                      </span>
                    </Show>
                  </button>
                </div>
              </Dialog.Content>
            </div>
          </Dialog.Portal>
        </Dialog>

        <Show when={options.onSaveServer}>
          {(onSubmit) => <RemoteServerDialog open={isServerDialogOpen()} onOpenChange={setIsServerDialogOpen} onSubmit={onSubmit()} />}
        </Show>
      </>
    )
  }

  return { browse, clone, addServer: () => setIsServerDialogOpen(true), isOpen, isFolderBrowserOpen, Dialogs }
}
