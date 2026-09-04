import { Show, type Accessor, type Component } from "solid-js"
import type { SessionThread } from "../../../stores/session-state"
import type { KeyboardShortcut } from "../../../lib/keyboard-registry"
import type { DrawerViewState } from "./types"

import { PlusSquare, Search } from "lucide-solid"
import IconButton from "@suid/material/IconButton"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"
import InfoOutlinedIcon from "@suid/icons-material/InfoOutlined"

import SessionList from "../../session-list"
import KeyboardHint from "../../keyboard-hint"
import WorktreeSelector from "../../worktree-selector"
import { getLogger } from "../../../lib/logger"
import { shouldMountSessionList } from "../../session-list-visibility"

const log = getLogger("session")

interface SessionSidebarProps {
  t: (key: string) => string
  instanceId: string
  threads: Accessor<SessionThread[]>
  activeSessionId: Accessor<string | null>

  showSearch: Accessor<boolean>
  onToggleSearch: () => void

  keyboardShortcuts: Accessor<KeyboardShortcut[]>
  drawerState: Accessor<DrawerViewState>

  onSelectSession: (sessionId: string) => void
  onNewSession: () => Promise<void> | void
  onCloseLeftDrawer: () => void

  setContentEl: (el: HTMLElement | null) => void
}

const SessionSidebar: Component<SessionSidebarProps> = (props) => (
    <div class="flex flex-col h-full min-h-0" ref={props.setContentEl}>
      <div class="panel-header session-sidebar-header border-b border-base">
        <div class="flex items-center justify-between gap-2">
          <span class="session-sidebar-title">
            {props.t("instanceShell.leftPanel.sessionsTitle")}
          </span>
          <div class="panel-header-actions session-sidebar-header-actions">
            <IconButton
              size="small"
              color="inherit"
              aria-label={props.t("sessionList.actions.newSession.ariaLabel")}
              title={props.t("sessionList.actions.newSession.title")}
              onClick={() => {
                const result = props.onNewSession()
                if (result instanceof Promise) {
                  void result.catch((error) => log.error("Failed to create session:", error))
                }
              }}
            >
              <PlusSquare class="w-4 h-4" />
            </IconButton>
            <IconButton
              class="icon-toggle"
              size="small"
              color="inherit"
              aria-label={props.t("sessionList.filter.ariaLabel")}
              title={props.t("sessionList.filter.ariaLabel")}
              aria-pressed={props.showSearch()}
              onClick={props.onToggleSearch}
            >
              <Search class="w-4 h-4" />
            </IconButton>
            <IconButton
              class="icon-toggle"
              size="small"
              color="inherit"
              aria-label={props.t("instanceShell.leftPanel.instanceInfo")}
              title={props.t("instanceShell.leftPanel.instanceInfo")}
              aria-pressed={props.activeSessionId() === "info"}
              onClick={() => props.onSelectSession("info")}
            >
              <InfoOutlinedIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              color="inherit"
              aria-label={props.t("instanceShell.leftDrawer.toggle.close")}
              title={props.t("instanceShell.leftDrawer.toggle.close")}
              onClick={props.onCloseLeftDrawer}
            >
              <MenuOpenIcon fontSize="small" />
            </IconButton>
          </div>
        </div>
        <div class="session-sidebar-shortcuts">
          <Show when={props.keyboardShortcuts().length}>
            <KeyboardHint shortcuts={props.keyboardShortcuts()} separator=" " showDescription={false} />
          </Show>
        </div>
      </div>

      <div class="session-sidebar flex flex-col flex-1 min-h-0">
        <Show when={shouldMountSessionList(props.drawerState())}>
          <SessionList
            instanceId={props.instanceId}
            threads={props.threads()}
            activeSessionId={props.activeSessionId()}
            onSelect={props.onSelectSession}
            onNew={() => {
              const result = props.onNewSession()
              if (result instanceof Promise) {
                void result.catch((error) => log.error("Failed to create session:", error))
              }
            }}
            enableFilterBar={props.showSearch()}
            showHeader={false}
            showFooter={false}
          />
        </Show>

        <div class="session-sidebar-separator" />
        <Show when={props.activeSessionId() && props.activeSessionId() !== "info"}>
          <div class="session-sidebar-controls px-6 border-t border-base">
            <div class="session-sidebar-selector-group">
              <WorktreeSelector instanceId={props.instanceId} sessionId={props.activeSessionId() ?? ""} />
            </div>
          </div>
        </Show>
      </div>
    </div>
  )

export default SessionSidebar
