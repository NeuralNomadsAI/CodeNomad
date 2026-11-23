import { ContextMenu } from "@kobalte/core/context-menu"
import { Component, Show, createMemo, createUniqueId } from "solid-js"
import type { Instance } from "../types/instance"
import { getInstanceStatusPresentation } from "../stores/session-status"
import { createDeadlineMemo } from "../lib/deadline-memo"
import { Activity, FolderCheck, FolderOpen, Hourglass, Pencil, Server, ShieldAlert, X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { useConfig } from "../stores/preferences"
import { keepTemporaryInstance } from "../stores/temporary-instances"
import { withHotkey, matchesHotkey } from "../lib/hotkeys"
import { getInstanceLabel } from "../lib/instance-label"
import { backendIdOf } from "../lib/backend-identity"
import { qualifiedServerDisplayName } from "../lib/codenomad-link"

interface InstanceTabProps {
  instance: Instance
  active: boolean
  onSelect: () => void
  onClose: () => void
  /** Receives the label currently shown, used as the rename default. */
  onRename: (label: string) => void
}

const InstanceTab: Component<InstanceTabProps> = (props) => {
  const { t } = useI18n()
  const { preferences, remoteServers } = useConfig()
  const statusId = createUniqueId()
  const statusPresentation = createDeadlineMemo((now, wakeAt) =>
    getInstanceStatusPresentation(props.instance.id, now, preferences().keepUnseenSubagentIdleStatus, wakeAt),
  )
  const aggregatedStatus = () => statusPresentation().status
  const statusClassName = createMemo(() => {
    const status = aggregatedStatus()
    if (!status) return null
    if (status === "permission") return "session-permission"
    const base = `session-${status}`
    const fadeClass = statusPresentation().fade
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
  const serverName = createMemo(() => {
    const id = backendIdOf(props.instance)
    if (id === "local") return
    const profile = remoteServers().find(p => p.id === id)
    return profile ? qualifiedServerDisplayName(profile, remoteServers()) : id
  })
  const tabLabel = createMemo(() => getInstanceLabel(props.instance) || serverName() || "")
  const remoteDetail = () => serverName() ? `${tabLabel()} · ${serverName()} · ${props.instance.folder}` : undefined
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
            if (event.target !== event.currentTarget || !matchesHotkey("instance-rename", event)) return
            event.preventDefault()
            event.stopPropagation()
            requestRename()
          }}
          title={remoteDetail() ?? (props.instance.temporary ? t("instanceTab.temporary.title") : props.instance.folder)}
          aria-label={remoteDetail()}
          aria-describedby={statusTitle() ? statusId : undefined}
          role="tab"
          aria-selected={props.active}
        >
          <Show when={!serverName()} fallback={<Server class="w-4 h-4 flex-shrink-0" aria-hidden="true" />}>
            <Show when={props.instance.temporary} fallback={<FolderOpen class="w-4 h-4 flex-shrink-0" />}>
              <Hourglass class="w-4 h-4 flex-shrink-0" aria-label={t("instanceTab.temporary.ariaLabel")} />
            </Show>
          </Show>
          <span class="tab-label">
            {tabLabel()}
          </span>
          <Show when={statusClassName() && statusTitle()}>
            <span
              class={`status-indicator session-status ml-auto ${statusClassName()}`}
              title={statusTitle() ?? undefined}
              aria-hidden="true"
            >
              {aggregatedStatus() === "permission" ? (
                <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" />
              ) : aggregatedStatus() === "idle" ? (
                <span class="status-dot" />
              ) : (
                <Activity class="w-3.5 h-3.5" style={{ color: "var(--session-status-dot)" }} />
              )}
            </span>
            <span id={statusId} hidden>{t("instanceTab.status.ariaLabel", { status: statusTitle() ?? "" })}</span>
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
            title={props.active ? withHotkey(t("instanceTab.actions.close.ariaLabel"), "close-instance") : t("instanceTab.actions.close.ariaLabel")}
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
          <ContextMenu.Item class="action-overflow-item" onSelect={() => { renameSelected = true }}
            title={withHotkey(t("instanceTab.actions.rename"), "instance-rename")}>
            <span class="action-overflow-item-icon" aria-hidden="true"><Pencil class="w-3.5 h-3.5" /></span>
            <span class="action-overflow-item-label">{t("instanceTab.actions.rename")}</span>
          </ContextMenu.Item>
          <Show when={props.instance.temporary}>
            <ContextMenu.Item class="action-overflow-item" onSelect={() => void keepTemporaryInstance(props.instance.id)}>
              <span class="action-overflow-item-icon" aria-hidden="true"><FolderCheck class="w-3.5 h-3.5" /></span>
              <span class="action-overflow-item-label">{t("instanceTab.actions.keepTemporary")}</span>
            </ContextMenu.Item>
          </Show>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

export default InstanceTab
