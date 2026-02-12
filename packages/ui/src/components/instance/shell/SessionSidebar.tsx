import { Show, type Accessor, type Component } from "solid-js"
import type { SessionThread } from "../../../stores/session-state"
import type { Session } from "../../../types/session"
import type { KeyboardShortcut } from "../../../lib/keyboard-registry"
import type { DrawerViewState } from "./types"

import { PlusSquare, Search } from "lucide-solid"
import IconButton from "@suid/material/IconButton"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"
import PushPinIcon from "@suid/icons-material/PushPin"
import PushPinOutlinedIcon from "@suid/icons-material/PushPinOutlined"
import InfoOutlinedIcon from "@suid/icons-material/InfoOutlined"

import SessionList from "../../session-list"
import KeyboardHint from "../../keyboard-hint"
import Kbd from "../../kbd"
import WorktreeSelector from "../../worktree-selector"
import AgentSelector from "../../agent-selector"
import ModelSelector from "../../model-selector"
import ThinkingSelector from "../../thinking-selector"
import { getLogger } from "../../../lib/logger"

const log = getLogger("session")

interface SessionSidebarProps {
  t: (key: string) => string
  instanceId: string
  threads: Accessor<SessionThread[]>
  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>

  showSearch: Accessor<boolean>
  onToggleSearch: () => void

  keyboardShortcuts: Accessor<KeyboardShortcut[]>
  isPhoneLayout: Accessor<boolean>
  drawerState: Accessor<DrawerViewState>
  leftPinned: Accessor<boolean>

  onSelectSession: (sessionId: string) => void
  onNewSession: () => Promise<void> | void
  onSidebarAgentChange: (sessionId: string, agent: string) => Promise<void>
  onSidebarModelChange: (sessionId: string, model: { providerId: string; modelId: string }) => Promise<void>
  onPinLeftDrawer: () => void
  onUnpinLeftDrawer: () => void
  onCloseLeftDrawer: () => void

  setContentEl: (el: HTMLElement | null) => void
}

const SessionSidebar: Component<SessionSidebarProps> = (props) => (
  <div class="flex flex-col h-full min-h-0" ref={props.setContentEl}>
    <div class="flex flex-col gap-2 px-4 py-3 border-b border-base">
      <div class="flex items-center justify-between gap-2">
        <span class="session-sidebar-title text-sm font-semibold uppercase text-primary">
          {props.t("instanceShell.leftPanel.sessionsTitle")}
        </span>
        <div class="flex items-center gap-2 text-primary">
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
            <PlusSquare class="w-5 h-5" />
          </IconButton>
          <IconButton
            size="small"
            color="inherit"
            aria-label={props.t("sessionList.filter.ariaLabel")}
            title={props.t("sessionList.filter.ariaLabel")}
            aria-pressed={props.showSearch()}
            onClick={props.onToggleSearch}
            sx={{
              color: props.showSearch() ? "var(--text-primary)" : "inherit",
              backgroundColor: props.showSearch() ? "var(--surface-hover)" : "transparent",
              "&:hover": {
                backgroundColor: "var(--surface-hover)",
              },
            }}
          >
            <Search class="w-5 h-5" />
          </IconButton>
          <IconButton
            size="small"
            color="inherit"
            aria-label={props.t("instanceShell.leftPanel.instanceInfo")}
            title={props.t("instanceShell.leftPanel.instanceInfo")}
            onClick={() => props.onSelectSession("info")}
          >
            <InfoOutlinedIcon fontSize="small" />
          </IconButton>
          <Show when={!props.isPhoneLayout()}>
            <IconButton
              size="small"
              color="inherit"
              aria-label={props.leftPinned() ? props.t("instanceShell.leftDrawer.unpin") : props.t("instanceShell.leftDrawer.pin")}
              onClick={() => (props.leftPinned() ? props.onUnpinLeftDrawer() : props.onPinLeftDrawer())}
            >
              {props.leftPinned() ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
            </IconButton>
          </Show>
          <Show when={props.drawerState() === "floating-open"}>
            <IconButton
              size="small"
              color="inherit"
              aria-label={props.t("instanceShell.leftDrawer.toggle.close")}
              title={props.t("instanceShell.leftDrawer.toggle.close")}
              onClick={props.onCloseLeftDrawer}
            >
              <MenuOpenIcon fontSize="small" />
            </IconButton>
          </Show>
        </div>
      </div>
      <div class="session-sidebar-shortcuts">
        <Show when={props.keyboardShortcuts().length}>
          <KeyboardHint shortcuts={props.keyboardShortcuts()} separator=" " showDescription={false} />
        </Show>
      </div>
    </div>

    <div class="session-sidebar flex flex-col flex-1 min-h-0">
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

      <div class="session-sidebar-separator" />
      <Show when={props.activeSession()}>
        {(activeSession) => (
          <>
            <div class="session-sidebar-controls px-4 py-4 border-t border-base flex flex-col gap-3">
              <WorktreeSelector instanceId={props.instanceId} sessionId={activeSession().id} />

              <AgentSelector
                instanceId={props.instanceId}
                sessionId={activeSession().id}
                currentAgent={activeSession().agent}
                onAgentChange={(agent) => props.onSidebarAgentChange(activeSession().id, agent)}
              />

              <ModelSelector
                instanceId={props.instanceId}
                sessionId={activeSession().id}
                currentModel={activeSession().model}
                onModelChange={(model) => props.onSidebarModelChange(activeSession().id, model)}
              />

              <ThinkingSelector instanceId={props.instanceId} currentModel={activeSession().model} />

              <div class="session-sidebar-selector-hints" aria-hidden="true">
                <Kbd shortcut="cmd+shift+a" />
                <Kbd shortcut="cmd+shift+m" />
                <Kbd shortcut="cmd+shift+t" />
              </div>
            </div>
          </>
        )}
      </Show>
    </div>
  </div>
)

export default SessionSidebar
