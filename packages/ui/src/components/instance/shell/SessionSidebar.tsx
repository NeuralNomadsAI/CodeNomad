import { For, Show, createMemo, createSignal, type Accessor, type Component } from "solid-js"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import type { SessionThread } from "../../../stores/session-state"
import type { Session } from "../../../types/session"
import { keyboardRegistry, type KeyboardShortcut } from "../../../lib/keyboard-registry"
import type { DrawerViewState } from "./types"

import { Check, ListFilter, PlusSquare, Search } from "lucide-solid"
import IconButton from "@suid/material/IconButton"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"
import PushPinIcon from "@suid/icons-material/PushPin"
import PushPinOutlinedIcon from "@suid/icons-material/PushPinOutlined"
import InfoOutlinedIcon from "@suid/icons-material/InfoOutlined"

import SessionList from "../../session-list"
import KeyboardHint from "../../keyboard-hint"
import WorktreeSelector from "../../worktree-selector"
import AgentSelector from "../../agent-selector"
import ModelSelector from "../../model-selector"
import ThinkingSelector from "../../thinking-selector"
import { getLogger } from "../../../lib/logger"
import { shouldMountSessionList } from "../../session-list-visibility"
import { getWorktrees } from "../../../stores/worktrees"
import type { SessionThreadSortMode } from "../../../stores/session-tree"

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
  isPhoneLayout: Accessor<boolean>
  drawerState: Accessor<DrawerViewState>
  leftPinned: Accessor<boolean>

  onSelectSession: (sessionId: string) => void
  onNewSession: () => Promise<void> | void
  onSidebarAgentChange: (sessionId: string, agent: string) => Promise<void>
  onSidebarModelChange: (sessionId: string, model: { providerId: string; modelId: string }) => Promise<void>
  onDraftAgentChange?: (agent: string) => Promise<void>
  onDraftModelChange?: (model: { providerId: string; modelId: string }) => Promise<void>
  onPinLeftDrawer: () => void
  onUnpinLeftDrawer: () => void
  onCloseLeftDrawer: () => void

  setContentEl: (el: HTMLElement | null) => void
}

const SessionSidebar: Component<SessionSidebarProps> = (props) => {
  const [sortMode, setSortMode] = createSignal<SessionThreadSortMode>("activity")
  const [selectedWorktree, setSelectedWorktree] = createSignal<string | null>(null)
  const worktrees = createMemo(() => getWorktrees(props.instanceId))
  const worktreeFilter = createMemo(() => {
    const selected = selectedWorktree()
    return selected && worktrees().some((worktree) => worktree.slug === selected) ? selected : null
  })
  const optionsActive = createMemo(() => sortMode() !== "activity" || worktreeFilter() !== null)
  const sortOptions: Array<{ value: SessionThreadSortMode; labelKey: string }> = [
    { value: "activity", labelKey: "sessionList.options.sort.activity" },
    { value: "name", labelKey: "sessionList.options.sort.name" },
    { value: "worktree", labelKey: "sessionList.options.sort.worktree" },
  ]

  return (
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
            <DropdownMenu placement="bottom-end" gutter={4}>
              <DropdownMenu.Trigger
                as={IconButton}
                size="small"
                color="inherit"
                aria-label={props.t("sessionList.options.ariaLabel")}
                title={props.t("sessionList.options.ariaLabel")}
                sx={{
                  color: optionsActive() ? "var(--text-primary)" : "inherit",
                  backgroundColor: optionsActive() ? "var(--surface-hover)" : "transparent",
                  "&:hover": { backgroundColor: "var(--surface-hover)" },
                }}
              >
                <ListFilter class="w-5 h-5" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="action-overflow-content">
                  <div class="px-2 py-1 text-xs font-semibold uppercase text-muted">
                    {props.t("sessionList.options.sort.label")}
                  </div>
                  <For each={sortOptions}>
                    {(option) => (
                      <DropdownMenu.Item
                        class="action-overflow-item"
                        role="menuitemradio"
                        aria-checked={sortMode() === option.value}
                        onSelect={() => setSortMode(option.value)}
                      >
                        <span class="action-overflow-item-icon" aria-hidden="true">
                          <Show when={sortMode() === option.value}><Check class="w-3.5 h-3.5" /></Show>
                        </span>
                        <span class="action-overflow-item-label">{props.t(option.labelKey)}</span>
                      </DropdownMenu.Item>
                    )}
                  </For>
                  <div class="my-1 border-t border-base" role="separator" />
                  <div class="px-2 py-1 text-xs font-semibold uppercase text-muted">
                    {props.t("sessionList.options.filter.label")}
                  </div>
                  <DropdownMenu.Item
                    class="action-overflow-item"
                    role="menuitemradio"
                    aria-checked={worktreeFilter() === null}
                    onSelect={() => setSelectedWorktree(null)}
                  >
                    <span class="action-overflow-item-icon" aria-hidden="true">
                      <Show when={worktreeFilter() === null}><Check class="w-3.5 h-3.5" /></Show>
                    </span>
                    <span class="action-overflow-item-label">{props.t("sessionList.options.filter.all")}</span>
                  </DropdownMenu.Item>
                  <For each={worktrees()}>
                    {(worktree) => (
                      <DropdownMenu.Item
                        class="action-overflow-item"
                        role="menuitemradio"
                        aria-checked={worktreeFilter() === worktree.slug}
                        onSelect={() => setSelectedWorktree(worktree.slug)}
                      >
                        <span class="action-overflow-item-icon" aria-hidden="true">
                          <Show when={worktreeFilter() === worktree.slug}><Check class="w-3.5 h-3.5" /></Show>
                        </span>
                        <span class="action-overflow-item-label">
                          {worktree.slug === "root" ? props.t("sessionList.options.filter.workspace") : worktree.slug}
                        </span>
                      </DropdownMenu.Item>
                    )}
                  </For>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
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
            sortMode={sortMode()}
            worktreeFilter={worktreeFilter()}
            showHeader={false}
            showFooter={false}
          />
        </Show>

        <div class="session-sidebar-separator" />
        <Show
          when={props.activeSession()}
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
          {(activeSession) => (
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
          )}
        </Show>
      </div>
    </div>
  )
}

export default SessionSidebar
