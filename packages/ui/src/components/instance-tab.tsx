import { ContextMenu } from "@kobalte/core/context-menu"
import { Component, Show, createMemo, createSignal, onCleanup } from "solid-js"
import type { Instance } from "../types/instance"
import { getInstanceIdleFadeClass, getInstanceSessionIndicatorStatus } from "../stores/session-status"
import { FolderOpen, Pencil, ShieldAlert, X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { useConfig } from "../stores/preferences"

interface InstanceTabProps {
  instance: Instance
  active: boolean
  onSelect: () => void
  onClose: () => void
  /** Receives the label currently shown, used as the rename default. */
  onRename: (label: string) => void
}

function getPathBasename(path: string): string {
  // Instance folders can be POSIX-like (/Users/...) on macOS/Linux or Windows-like (C:\Users\...).
  // Normalize by trimming trailing separators and then splitting on both '/' and '\\'.
  const normalized = path.replace(/[\\/]+$/, "")
  return normalized.split(/[\\/]/).pop() || path
}

const InstanceTab: Component<InstanceTabProps> = (props) => {
  const { t } = useI18n()
  const { preferences } = useConfig()
  const [now, setNow] = createSignal(Date.now())

  if (typeof window !== "undefined") {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))
  }

  const aggregatedStatus = createMemo(() =>
    getInstanceSessionIndicatorStatus(props.instance.id, now(), preferences().keepUnseenSubagentIdleStatus),
  )
  const statusClassName = createMemo(() => {
    const status = aggregatedStatus()
    if (!status) return null
    if (status === "permission") return "session-permission"
    const base = `session-${status}`
    const fadeClass =
      status === "idle" ? getInstanceIdleFadeClass(props.instance.id, now(), preferences().keepUnseenSubagentIdleStatus) : ""
    return fadeClass ? `${base} ${fadeClass}` : base
  })
  const statusTitle = createMemo(() => {
    switch (aggregatedStatus()) {
      case "permission":
        return t("instanceTab.status.permission")
      case "compacting":
        return t("instanceTab.status.compacting")
      case "working":
        return t("instanceTab.status.working")
      case "idle":
        return t("instanceTab.status.idle")
      default:
        return null
    }
  })
  const tabLabel = createMemo(() => props.instance.projectName?.trim() || getPathBasename(props.instance.folder))
  const requestRename = () => props.onRename(tabLabel())
  // The menu restores focus to the tab when it closes; open the dialog after
  // that so the dialog keeps focus on its input.
  let renameSelected = false

  return (
    <ContextMenu>
      <ContextMenu.Trigger class="group">
        <button
          class={`tab-base ${props.active ? "tab-active" : "tab-inactive"}`}
          onClick={props.onSelect}
          onDblClick={(event) => {
            if ((event.target as Element).closest(".tab-close")) return
            requestRename()
          }}
          onKeyDown={(event) => {
            if (event.key !== "F2") return
            event.preventDefault()
            requestRename()
          }}
          title={props.instance.folder}
          role="tab"
          aria-selected={props.active}
        >
          <FolderOpen class="w-4 h-4 flex-shrink-0" />
          <span class="tab-label">
            {tabLabel()}
          </span>
          <Show when={statusClassName() && statusTitle()}>
            <span
              class={`status-indicator session-status ml-auto ${statusClassName()}`}
              title={statusTitle() ?? undefined}
              aria-label={t("instanceTab.status.ariaLabel", { status: statusTitle() ?? "" })}
            >
              {aggregatedStatus() === "permission" ? (
                <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <span class="status-dot" />
              )}
            </span>
          </Show>
          <span
            class="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              props.onClose()
            }}
            onPointerDown={(e) => e.stopPropagation()}
            role="button"
            tabIndex={0}
            aria-label={t("instanceTab.actions.close.ariaLabel")}
          >
            <X class="w-3 h-3" />
          </span>
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          class="action-overflow-content"
          onCloseAutoFocus={() => {
            if (!renameSelected) return
            renameSelected = false
            queueMicrotask(requestRename)
          }}
        >
          <ContextMenu.Item class="action-overflow-item" onSelect={() => { renameSelected = true }}>
            <span class="action-overflow-item-icon" aria-hidden="true"><Pencil class="w-3.5 h-3.5" /></span>
            <span class="action-overflow-item-label">{t("instanceTab.actions.rename")}</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

export default InstanceTab
