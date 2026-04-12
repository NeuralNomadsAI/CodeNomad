import { createSignal, type Accessor } from "solid-js"
import { serverApi } from "../../../../../lib/api-client"
import { showConfirmDialog } from "../../../../../stores/alerts"
import { showToastNotification } from "../../../../../lib/notifications"

export interface FileOperationState {
  inProgress: boolean
  progress: number
  label: string
  cancel?: () => void
  isComplete: boolean
  isCancelled: boolean
}

export function useFileOperations(
  instanceId: string,
  worktreeSlug: Accessor<string>,
  t: (key: string, vars?: Record<string, any>) => string,
  onRefresh?: () => void,
) {
  const [operation, setOperation] = createSignal<FileOperationState>({
    inProgress: false,
    progress: 0,
    label: "",
    isComplete: false,
    isCancelled: false,
  })

  const resetOperation = () => {
    setOperation({
      inProgress: false,
      progress: 0,
      label: "",
      isComplete: false,
      isCancelled: false,
    })
  }

  const uploadFile = async (targetPath: string, file: File, overwrite = false) => {
    try {
      setOperation({ inProgress: true, progress: 0, label: t("fileViewer.actions.uploading", { file: file.name }), isComplete: false, isCancelled: false })
      const { promise, abort } = serverApi.uploadWorkspaceFile(
        instanceId,
        targetPath,
        file,
        (loaded, total) => {
          setOperation((prev) => ({ ...prev, progress: (loaded / total) * 100 }))
        },
        { worktree: worktreeSlug(), overwrite },
      )
      setOperation((prev) => ({ ...prev, cancel: abort }))
      await promise
      setOperation((prev) => ({ ...prev, progress: 100, label: t("fileViewer.actions.uploadComplete"), isComplete: true }))
      showToastNotification({ message: t("instanceShell.rightPanel.actions.uploadSuccess"), variant: "success" })
      onRefresh?.()
    } catch (error: any) {
      if (error?.status === 409 && !overwrite) {
        const confirmed = await showConfirmDialog(
          t("instanceShell.rightPanel.actions.uploadConflict.message"),
          {
            variant: "warning",
            confirmLabel: t("instanceShell.rightPanel.actions.uploadConflict.confirmLabel"),
            cancelLabel: t("instanceShell.rightPanel.actions.uploadConflict.cancelLabel"),
            dismissible: false,
          },
        )
        if (confirmed) {
          return uploadFile(targetPath, file, true)
        }
        setOperation((prev) => ({ ...prev, label: t("fileViewer.actions.uploadCancelled"), isCancelled: true }))
        return
      }
      setOperation((prev) => ({ ...prev, label: t("fileViewer.actions.uploadFailed"), isCancelled: true }))
      showToastNotification({ message: t("instanceShell.rightPanel.actions.uploadFailed"), variant: "error" })
    }
  }

  const downloadFile = async (relativePath: string) => {
    try {
      const fileName = relativePath.split("/").pop() || "download"
      setOperation({ inProgress: true, progress: 0, label: t("fileViewer.actions.downloading", { file: fileName }), isComplete: false, isCancelled: false })
      const { promise, abort } = serverApi.downloadWorkspaceFile(
        instanceId,
        relativePath,
        (loaded, total) => {
          setOperation((prev) => ({ ...prev, progress: (loaded / total) * 100 }))
        },
        { worktree: worktreeSlug() },
      )
      setOperation((prev) => ({ ...prev, cancel: abort }))
      const result = await promise

      setOperation((prev) => ({ ...prev, progress: 100, label: t("fileViewer.actions.downloadComplete"), isComplete: true }))

      // Trigger browser download
      const a = document.createElement("a")
      a.href = result.blobUrl
      a.download = result.fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)

      showToastNotification({ message: t("instanceShell.rightPanel.actions.downloadSuccess"), variant: "success" })
      URL.revokeObjectURL(result.blobUrl)
    } catch (error: any) {
      const isCancelled = error?.message?.includes("cancelled")
      setOperation((prev) => ({ ...prev, label: isCancelled ? t("fileViewer.actions.downloadCancelled") : t("fileViewer.actions.downloadFailed"), isCancelled: true }))
      if (!isCancelled) {
        showToastNotification({ message: t("instanceShell.rightPanel.actions.downloadFailed"), variant: "error" })
      }
    }
  }

  const deleteFile = async (relativePath: string, hasDirtyState: boolean) => {
    const fileName = relativePath.split("/").pop() || relativePath

    if (hasDirtyState) {
      const confirmed = await showConfirmDialog(
        t("fileViewer.delete.dirty.message", { path: fileName }),
        {
          variant: "warning",
          confirmLabel: t("fileViewer.delete.confirm.label"),
          cancelLabel: t("fileViewer.delete.cancel.label"),
          dismissible: false,
        },
      )
      if (!confirmed) return
    } else {
      const confirmed = await showConfirmDialog(
        t("fileViewer.delete.confirm.message", { path: fileName }),
        {
          variant: "info",
          confirmLabel: t("fileViewer.delete.confirm.label"),
          cancelLabel: t("fileViewer.delete.cancel.label"),
          dismissible: false,
        },
      )
      if (!confirmed) return
    }

    try {
      await serverApi.deleteWorkspaceFile(instanceId, relativePath, { worktree: worktreeSlug() })
      showToastNotification({ message: t("instanceShell.rightPanel.actions.deleteSuccess"), variant: "success" })
      onRefresh?.()
    } catch (error: any) {
      if (error?.message?.includes("Folder deletion")) {
        showToastNotification({ message: t("instanceShell.rightPanel.actions.deleteFolderNotAllowed"), variant: "error" })
      } else {
        showToastNotification({ message: t("instanceShell.rightPanel.actions.deleteFailed"), variant: "error" })
      }
    }
  }

  return {
    operation,
    resetOperation,
    uploadFile,
    downloadFile,
    deleteFile,
  }
}
