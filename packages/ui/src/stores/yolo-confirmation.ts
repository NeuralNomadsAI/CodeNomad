import type { showConfirmDialog } from "./alerts"

type ConfirmOptions = Parameters<typeof showConfirmDialog>[1]

export function createSubagentYoloConfirmDialogArgs(
  t: (key: string) => string,
): [message: string, options: ConfirmOptions] {
  return [
    t("instanceShell.yoloMode.subagents.confirm.body"),
    {
      title: t("instanceShell.yoloMode.subagents.confirm.title"),
      confirmLabel: t("instanceShell.yoloMode.subagents.confirm.enable"),
      cancelLabel: t("instanceShell.yoloMode.subagents.confirm.cancel"),
      variant: "warning",
    },
  ]
}

export async function confirmSubagentsInheritYoloModeChange(
  currentEnabled: boolean,
  nextEnabled: boolean,
  confirmEnable: () => Promise<boolean>,
): Promise<boolean> {
  if (currentEnabled === nextEnabled) return true
  if (!nextEnabled) return true
  return confirmEnable()
}
