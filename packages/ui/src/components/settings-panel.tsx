import { Component, Show, createSignal, createEffect } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, Server, ChevronDown, ChevronRight, Settings, Plug, Info, Zap, MessageSquare, Shield, ShieldCheck, ShieldOff, Sun, Moon, Monitor } from "lucide-solid"
import { cn } from "../lib/cn"
import { Switch } from "./ui"
import type { Instance } from "../types/instance"
import { preferences, toggleDefaultToolCallsCollapsed, toggleShowVerboseOutput, toggleAutoApprovePermissions, useConfig } from "../stores/preferences"
import EraStatusBadge from "./era-status-badge"
import {
  isEraInstalled,
  eraVersion,
  eraAssetCounts,
  areEraAssetsAvailable,
  initEraStatus,
} from "../stores/era-status"

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  instance: Instance | null
  serverStatus: "healthy" | "warning" | "error"
  onOpenMcpSettings?: () => void
  onOpenLspSettings?: () => void
  onOpenAdvancedSettings?: () => void
  onOpenCommandsSettings?: () => void
  onOpenGovernancePanel?: () => void
}

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const [showInstanceDetails, setShowInstanceDetails] = createSignal(false)

  const statusLabel = () => {
    switch (props.serverStatus) {
      case "healthy": return "Server Running"
      case "warning": return "Server Warning"
      case "error": return "Server Error"
    }
  }

  const statusColor = () => {
    switch (props.serverStatus) {
      case "healthy": return "bg-success"
      case "warning": return "bg-warning"
      case "error": return "bg-destructive"
    }
  }

  const statusTextColor = () => {
    switch (props.serverStatus) {
      case "healthy": return "text-success"
      case "warning": return "text-warning"
      case "error": return "text-destructive"
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
        <div class="fixed inset-y-0 right-0 z-50 flex">
          <Dialog.Content class="flex flex-col w-80 bg-background border-l border-border shadow-xl">
            <div class="flex items-center justify-between px-4 py-3 border-b border-border">
              <Dialog.Title class="text-base font-semibold text-foreground">Quick Settings</Dialog.Title>
              <Dialog.CloseButton class="p-1.5 rounded transition-colors text-muted-foreground hover:bg-accent hover:text-foreground">
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            <div class="flex-1 overflow-y-auto p-4 space-y-5">
              {/* Server Status */}
              <div>
                <div class="flex items-center gap-2">
                  <div class={cn("w-2.5 h-2.5 rounded-full", statusColor())} />
                  <span class={cn("text-sm font-medium", statusTextColor())}>
                    {statusLabel()}
                  </span>
                </div>
              </div>

              {/* Quick Actions */}
              <div>
                <h3 class="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Configuration</h3>
                <div class="flex flex-col gap-1">
                  <button
                    class="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-foreground transition-colors hover:bg-accent"
                    onClick={() => props.onOpenCommandsSettings?.()}
                  >
                    <Zap class="w-4 h-4" />
                    <span>Slash Commands</span>
                  </button>
                  <button
                    class="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-foreground transition-colors hover:bg-accent"
                    onClick={() => props.onOpenMcpSettings?.()}
                  >
                    <Plug class="w-4 h-4" />
                    <span>MCP Servers</span>
                  </button>
                  <button
                    class="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-foreground transition-colors hover:bg-accent"
                    onClick={() => props.onOpenLspSettings?.()}
                  >
                    <Server class="w-4 h-4" />
                    <span>LSP Servers</span>
                  </button>
                  <button
                    class="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-foreground transition-colors hover:bg-accent"
                    onClick={() => props.onOpenAdvancedSettings?.()}
                  >
                    <Settings class="w-4 h-4" />
                    <span>All Settings</span>
                  </button>
                </div>
              </div>

              {/* Permissions Settings */}
              <div>
                <h3 class="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  {preferences().autoApprovePermissions ? (
                    <ShieldCheck class="w-4 h-4 text-success" />
                  ) : (
                    <ShieldOff class="w-4 h-4 text-warning" />
                  )}
                  <span>Permissions</span>
                </h3>
                <div class="space-y-1">
                  <label class="flex items-center justify-between py-2 px-1 rounded-md cursor-pointer hover:bg-accent">
                    <span class="flex flex-col gap-0.5 flex-1 min-w-0">
                      <span class="text-sm font-medium text-foreground">Auto-approve permissions</span>
                      <span class="text-xs text-muted-foreground">Skip permission prompts for file edits and commands (equivalent to --dangerously-skip-permissions)</span>
                    </span>
                    <Switch
                      checked={preferences().autoApprovePermissions}
                      onChange={toggleAutoApprovePermissions}
                      class="ml-3"
                    />
                  </label>
                </div>
              </div>

              {/* Chat Window Settings */}
              <div>
                <h3 class="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  <MessageSquare class="w-4 h-4" />
                  <span>Chat Window</span>
                </h3>
                <div class="space-y-1">
                  <label class="flex items-center justify-between py-2 px-1 rounded-md cursor-pointer hover:bg-accent">
                    <span class="flex flex-col gap-0.5 flex-1 min-w-0">
                      <span class="text-sm font-medium text-foreground">Collapse tool calls by default</span>
                      <span class="text-xs text-muted-foreground">Tool call sections start collapsed in messages</span>
                    </span>
                    <Switch
                      checked={preferences().defaultToolCallsCollapsed}
                      onChange={toggleDefaultToolCallsCollapsed}
                      class="ml-3"
                    />
                  </label>
                  <label class="flex items-center justify-between py-2 px-1 rounded-md cursor-pointer hover:bg-accent">
                    <span class="flex flex-col gap-0.5 flex-1 min-w-0">
                      <span class="text-sm font-medium text-foreground">Show verbose output</span>
                      <span class="text-xs text-muted-foreground">Display real-time streaming text while generating</span>
                    </span>
                    <Switch
                      checked={preferences().showVerboseOutput}
                      onChange={toggleShowVerboseOutput}
                      class="ml-3"
                    />
                  </label>
                </div>
              </div>

              {/* Theme */}
              <div>
                <h3 class="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  <Sun class="w-4 h-4" />
                  <span>Theme</span>
                </h3>
                {(() => {
                  const { themePreference, setThemePreference } = useConfig()
                  return (
                    <div class="flex rounded-lg border border-border overflow-hidden">
                      <button
                        type="button"
                        class={cn(
                          "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors",
                          themePreference() === "light" ? "bg-info text-info-foreground" : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
                        )}
                        onClick={() => setThemePreference("light")}
                      >
                        <Sun class="w-3.5 h-3.5" />
                        Light
                      </button>
                      <button
                        type="button"
                        class={cn(
                          "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors border-x border-border",
                          themePreference() === "dark" ? "bg-info text-info-foreground" : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
                        )}
                        onClick={() => setThemePreference("dark")}
                      >
                        <Moon class="w-3.5 h-3.5" />
                        Dark
                      </button>
                      <button
                        type="button"
                        class={cn(
                          "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors",
                          themePreference() === "system" ? "bg-info text-info-foreground" : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
                        )}
                        onClick={() => setThemePreference("system")}
                      >
                        <Monitor class="w-3.5 h-3.5" />
                        System
                      </button>
                    </div>
                  )
                })()}
              </div>

              {/* Era Code Section */}
              <div>
                <h3 class="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  <Shield class="w-4 h-4" />
                  <span>Era Code</span>
                </h3>
                <div class="space-y-3">
                  <EraStatusBadge />
                  <Show when={isEraInstalled()}>
                    <div class="flex items-center justify-between text-sm py-1">
                      <span class="text-muted-foreground">Version</span>
                      <span class="text-foreground font-mono">{eraVersion()}</span>
                    </div>
                    <Show when={areEraAssetsAvailable() && eraAssetCounts()}>
                      <div class="grid grid-cols-4 gap-2">
                        <div class="flex flex-col items-center p-2 rounded-md bg-secondary text-center">
                          <span class="text-xs text-muted-foreground">Agents</span>
                          <span class="text-sm font-semibold text-foreground">{eraAssetCounts()!.agents}</span>
                        </div>
                        <div class="flex flex-col items-center p-2 rounded-md bg-secondary text-center">
                          <span class="text-xs text-muted-foreground">Commands</span>
                          <span class="text-sm font-semibold text-foreground">{eraAssetCounts()!.commands}</span>
                        </div>
                        <div class="flex flex-col items-center p-2 rounded-md bg-secondary text-center">
                          <span class="text-xs text-muted-foreground">Skills</span>
                          <span class="text-sm font-semibold text-foreground">{eraAssetCounts()!.skills}</span>
                        </div>
                        <div class="flex flex-col items-center p-2 rounded-md bg-secondary text-center">
                          <span class="text-xs text-muted-foreground">Plugins</span>
                          <span class="text-sm font-semibold text-foreground">{eraAssetCounts()!.plugins}</span>
                        </div>
                      </div>
                    </Show>
                  </Show>
                  <Show when={isEraInstalled()}>
                    <button
                      class="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-foreground transition-colors hover:bg-accent"
                      onClick={() => props.onOpenGovernancePanel?.()}
                    >
                      <Shield class="w-4 h-4" />
                      <span>View Governance Rules</span>
                    </button>
                  </Show>
                  <Show when={!isEraInstalled()}>
                    <p class="text-xs text-muted-foreground">
                      Install Era Code for governance enforcement, custom agents, and enhanced development workflows.
                    </p>
                  </Show>
                </div>
              </div>

              {/* Instance Details (Collapsible) */}
              <Show when={props.instance}>
                <div>
                  <button
                    class="flex items-center gap-2 w-full text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2 rounded-md transition-colors hover:bg-accent"
                    onClick={() => setShowInstanceDetails(!showInstanceDetails())}
                  >
                    {showInstanceDetails() ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <Info class="w-4 h-4" />
                    <span>Instance Details</span>
                  </button>

                  <Show when={showInstanceDetails()}>
                    <div class="space-y-2 mt-2">
                      <div class="flex items-center justify-between text-sm">
                        <span class="text-muted-foreground">Instance ID</span>
                        <span class="text-foreground font-mono">
                          {props.instance?.id.slice(0, 8)}...
                        </span>
                      </div>
                      <div class="flex items-center justify-between text-sm">
                        <span class="text-muted-foreground">Folder</span>
                        <span class="text-foreground font-mono truncate max-w-[140px]">
                          {props.instance?.folder}
                        </span>
                      </div>
                      <div class="flex items-center justify-between text-sm">
                        <span class="text-muted-foreground">Port</span>
                        <span class="text-foreground font-mono">
                          {props.instance?.port}
                        </span>
                      </div>
                      <div class="flex items-center justify-between text-sm">
                        <span class="text-muted-foreground">PID</span>
                        <span class="text-foreground font-mono">
                          {props.instance?.pid}
                        </span>
                      </div>
                      <div class="flex items-center justify-between text-sm">
                        <span class="text-muted-foreground">Status</span>
                        <span class="text-foreground">
                          {props.instance?.status}
                        </span>
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default SettingsPanel
