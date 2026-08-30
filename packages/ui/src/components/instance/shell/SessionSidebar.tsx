import { Show, type Accessor, type Component } from "solid-js"
import type { SessionThread } from "../../../stores/session-state"
import type { Session } from "../../../types/session"
import { keyboardRegistry, type KeyboardShortcut } from "../../../lib/keyboard-registry"
import type { DrawerViewState } from "./types"

import { PlusSquare, Search } from "lucide-solid"
import IconButton from "@suid/material/IconButton"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"
import InfoOutlinedIcon from "@suid/icons-material/InfoOutlined"

import SessionList from "../../session-list"
import KeyboardHint from "../../keyboard-hint"
import WorktreeSelector from "../../worktree-selector"
import AgentSelector from "../../agent-selector"
import ModelSelector from "../../model-selector"
import ThinkingSelector from "../../thinking-selector"
import { getLogger } from "../../../lib/logger"
import { shouldMountSessionList } from "../../session-list-visibility"

const log = getLogger("session")

interface SessionSidebarProps {
  t: (key: string) => string
  instanceId: string
  threads: Accessor<SessionThread[]>
  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>
  draftAgent?: Accessor<string>
  draftModel?: Accessor<{ providerId: string; modelId: string }>

  showSearch: Accessor<boolean>
  onToggleSearch: () => void

  keyboardShortcuts: Accessor<KeyboardShortcut[]>
  drawerState: Accessor<DrawerViewState>

  onSelectSession: (sessionId: string) => void
  onNewSession: () => Promise<void> | void
  onSidebarAgentChange: (sessionId: string, agent: string) => Promise<void>
  onSidebarModelChange: (sessionId: string, model: { providerId: string; modelId: string }) => Promise<void>
  onDraftAgentChange?: (agent: string) => Promise<void>
  onDraftModelChange?: (model: { providerId: string; modelId: string }) => Promise<void>
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
        <Show
          when={props.activeSession()?.id}
          fallback={
            <Show when={props.draftAgent && props.draftModel && props.onDraftAgentChange && props.onDraftModelChange}>
              <div class="session-sidebar-controls px-4 py-4 border-t border-base flex flex-col gap-3">
                <AgentSelector
                  instanceId={props.instanceId}
                  sessionId="__new_session__"
                  currentAgent={props.draftAgent?.() ?? ""}
                  onAgentChange={(agent) => props.onDraftAgentChange!(agent)}
                />

                <ModelSelector
                  instanceId={props.instanceId}
                  sessionId="__new_session__"
                  currentModel={props.draftModel?.() ?? { providerId: "", modelId: "" }}
                  onModelChange={(model) => props.onDraftModelChange!(model)}
                />

                <ThinkingSelector instanceId={props.instanceId} currentModel={props.draftModel?.() ?? { providerId: "", modelId: "" }} />

                <KeyboardHint
                  class="session-sidebar-selector-hints"
                  ariaHidden={true}
                  shortcuts={[
                    keyboardRegistry.get("open-agent-selector"),
                    keyboardRegistry.get("focus-model"),
                    keyboardRegistry.get("focus-variant"),
                  ].filter((shortcut): shortcut is KeyboardShortcut => Boolean(shortcut))}
                  separator=" "
                  showDescription={false}
                />
              </div>
            </Show>
          }
        >
          <div class="session-sidebar-controls px-4 py-4 border-t border-base flex flex-col gap-3">
            <WorktreeSelector instanceId={props.instanceId} sessionId={props.activeSessionId() ?? ""} />

            <AgentSelector
              instanceId={props.instanceId}
              sessionId={props.activeSessionId() ?? ""}
              currentAgent={props.activeSession()?.agent ?? ""}
              onAgentChange={(agent) => {
                const sessionId = props.activeSessionId()
                return sessionId ? props.onSidebarAgentChange(sessionId, agent) : Promise.resolve()
              }}
            />

            <ModelSelector
              instanceId={props.instanceId}
              sessionId={props.activeSessionId() ?? ""}
              currentModel={props.activeSession()?.model ?? { providerId: "", modelId: "" }}
              onModelChange={(model) => {
                const sessionId = props.activeSessionId()
                return sessionId ? props.onSidebarModelChange(sessionId, model) : Promise.resolve()
              }}
            />

            <ThinkingSelector instanceId={props.instanceId} currentModel={props.activeSession()?.model ?? { providerId: "", modelId: "" }} />

            <KeyboardHint
              class="session-sidebar-selector-hints"
              ariaHidden={true}
              shortcuts={[
                keyboardRegistry.get("open-agent-selector"),
                keyboardRegistry.get("focus-model"),
                keyboardRegistry.get("focus-variant"),
              ].filter((shortcut): shortcut is KeyboardShortcut => Boolean(shortcut))}
              separator=" "
              showDescription={false}
            />
          </div>
        </Show>
      </div>
    </div>
  )

export default SessionSidebar
