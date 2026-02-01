import { For, Show, createMemo, createSignal, createEffect, type Component } from "solid-js"
import { useConfig } from "../stores/preferences"
import type { McpServerConfig } from "../stores/preferences"
import { instances } from "../stores/instances"
import { getLogger } from "../lib/logger"
import { instanceApi } from "../lib/instance-api"
import { loadInstanceMetadata } from "../lib/hooks/use-instance-metadata"
import {
  ERA_CODE_MCP_DEFAULTS,
  isBuiltInMcp,
  getBuiltInMcpConfig,
  getBuiltInMcpOptionValue,
  updateBuiltInMcpOption,
  type EraCodeMcpServer,
} from "../stores/era-mcp"
import {
  fetchProjectMcpConfig,
  getMergedMcpServers,
  setProjectMcpServer,
  removeProjectMcpServer,
  setProjectMcpOverride,
  type MergedMcpEntry,
} from "../stores/project-mcp"
import { Settings, Globe, FolderCog, Plus } from "lucide-solid"
import AddToGlobalModal from "./add-to-global-modal"
import { cn } from "../lib/cn"
import { Card, Badge, Button, Input, Switch, Label, Separator } from "./ui"

const log = getLogger("actions")

type McpScope = "global" | "project"

interface McpSettingsPanelProps {
  folder?: string
  instanceId?: string
  onAddServer?: () => void  // Opens external Add Server modal
}

const McpSettingsPanel: Component<McpSettingsPanelProps> = (props) => {
  const { preferences, updatePreferences } = useConfig()
  const [newName, setNewName] = createSignal("")
  const [newType, setNewType] = createSignal<McpServerConfig["type"]>("local")
  const [newCommand, setNewCommand] = createSignal("npx -y @modelcontextprotocol/server-everything")
  const [newUrl, setNewUrl] = createSignal("")
  const [scope, setScope] = createSignal<McpScope>("global")
  const [configuringServer, setConfiguringServer] = createSignal<string | null>(null)

  // Add to Global modal state
  const [addToGlobalOpen, setAddToGlobalOpen] = createSignal(false)
  const [pendingServer, setPendingServer] = createSignal<{ name: string; config: McpServerConfig } | null>(null)


  // Fetch project MCP config when folder changes
  createEffect(() => {
    const folder = props.folder
    if (folder) {
      void fetchProjectMcpConfig(folder)
    }
  })

  // Use merged servers when in project scope with a folder
  const entries = createMemo<MergedMcpEntry[]>(() => {
    const currentScope = scope()
    const folder = props.folder

    if (currentScope === "project" && folder) {
      return getMergedMcpServers(folder)
    }

    // Global scope: show era-code + global servers
    const registry = preferences().mcpRegistry ?? {}
    const desiredState = preferences().mcpDesiredState ?? {}

    // Start with built-in servers
    const builtInEntries: MergedMcpEntry[] = ERA_CODE_MCP_DEFAULTS.map((server) => {
      const override = registry[server.name]
      const config = override ?? getBuiltInMcpConfig(server.name) ?? server.config
      const desiredEnabled = desiredState[server.name] ?? (config.enabled ?? true)
      return {
        name: server.name,
        config,
        desiredEnabled,
        effectiveEnabled: desiredEnabled,
        source: "era-code" as const,
        builtIn: true,
        builtInServer: server,
        hasProjectOverride: false,
      }
    })

    // Add user-defined servers (excluding built-in overrides)
    const userEntries: MergedMcpEntry[] = Object.entries(registry)
      .filter(([name]) => !isBuiltInMcp(name))
      .map(([name, config]) => {
        const desiredEnabled = desiredState[name] ?? (config.enabled ?? true)
        return {
          name,
          config,
          desiredEnabled,
          effectiveEnabled: desiredEnabled,
          source: "global" as const,
          builtIn: false,
          hasProjectOverride: false,
        }
      })

    // Sort: built-ins first, then user-defined alphabetically
    return [
      ...builtInEntries.sort((a, b) => a.name.localeCompare(b.name)),
      ...userEntries.sort((a, b) => a.name.localeCompare(b.name)),
    ]
  })

  const saveEntry = (name: string, config: McpServerConfig, desiredEnabled: boolean) => {
    updatePreferences({
      mcpRegistry: { ...(preferences().mcpRegistry ?? {}), [name]: config },
      mcpDesiredState: { ...(preferences().mcpDesiredState ?? {}), [name]: desiredEnabled },
    })
  }

  const removeEntry = (name: string) => {
    const nextRegistry = { ...(preferences().mcpRegistry ?? {}) }
    const nextDesired = { ...(preferences().mcpDesiredState ?? {}) }
    delete nextRegistry[name]
    delete nextDesired[name]
    updatePreferences({ mcpRegistry: nextRegistry, mcpDesiredState: nextDesired })

    const activeInstances = Array.from(instances().values()).filter((instance) => instance.status === "ready" && instance.client)
    void Promise.all(
      activeInstances.map(async (instance) => {
        try {
          await instanceApi.disconnectMcp(instance, name)
          await loadInstanceMetadata(instance, { force: true })
        } catch {
          // ignore
        }
      }),
    )
  }

  const applyAll = async () => {
    const currentEntries = entries()
    const activeInstances = Array.from(instances().values()).filter((instance) => instance.status === "ready" && instance.client)

    await Promise.all(
      activeInstances.map(async (instance) => {
        for (const entry of currentEntries) {
          try {
            await instanceApi.upsertMcp(instance, entry.name, { ...entry.config, enabled: entry.desiredEnabled })
            if (entry.desiredEnabled) {
              await instanceApi.connectMcp(instance, entry.name)
            } else {
              await instanceApi.disconnectMcp(instance, entry.name)
            }
          } catch (error) {
            log.error("Failed to apply MCP registry entry", { instanceId: instance.id, name: entry.name, error })
          }
        }

        try {
          await loadInstanceMetadata(instance, { force: true })
        } catch (error) {
          log.error("Failed to refresh instance MCP metadata", { instanceId: instance.id, error })
        }
      }),
    )
  }

  const createNewServer = () => {
    const name = newName().trim()
    if (!name) return

    let config: McpServerConfig
    if (newType() === "local") {
      const command = newCommand()
        .split(" ")
        .map((segment) => segment.trim())
        .filter(Boolean)
      if (command.length === 0) return
      config = { type: "local", command, enabled: true }
    } else {
      const url = newUrl().trim()
      if (!url) return
      config = { type: "remote", url, enabled: true }
    }

    // If in project scope, show the "Add to Global?" modal
    if (scope() === "project" && props.folder) {
      setPendingServer({ name, config })
      setAddToGlobalOpen(true)
      return
    }

    // Global scope: save directly
    saveEntry(name, config, true)
    setNewName("")
    setNewUrl("")

    void applyAll()
  }

  const handleAddToGlobal = async () => {
    const server = pendingServer()
    if (!server) return

    // Save to global
    saveEntry(server.name, server.config, true)
    setNewName("")
    setNewUrl("")
    setPendingServer(null)

    void applyAll()
  }

  const handleKeepProjectOnly = async () => {
    const server = pendingServer()
    const folder = props.folder
    if (!server || !folder) return

    // Save to project only
    await setProjectMcpServer(folder, server.name, server.config)
    await fetchProjectMcpConfig(folder)
    setNewName("")
    setNewUrl("")
    setPendingServer(null)

    void applyAll()
  }

  return (
    <Card>
      <div class="flex flex-col space-y-1.5 px-4 py-3 border-b border-border bg-secondary">
        <h3 class="text-base font-semibold text-foreground">MCP Servers</h3>
        <p class="text-xs text-muted-foreground">Registry stored in Era Code and applied to all instances</p>
      </div>

      <div class="p-4 space-y-4">
        {/* Scope selector */}
        <Show when={props.folder}>
          <div class="flex items-center gap-1 rounded-lg border border-border bg-secondary p-1">
            <button
              type="button"
              class={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                scope() === "global"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setScope("global")}
            >
              <Globe class="w-4 h-4" />
              <span>Global</span>
            </button>
            <button
              type="button"
              class={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                scope() === "project"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setScope("project")}
            >
              <FolderCog class="w-4 h-4" />
              <span>Project</span>
            </button>
          </div>
        </Show>

        <Switch
          checked={preferences().mcpAutoApply}
          onChange={(checked) => updatePreferences({ mcpAutoApply: checked })}
          label="Auto-apply MCP registry on instance start"
          class="text-xs"
        />

        <div class="flex items-end flex-wrap gap-2">
          <div class="flex flex-col gap-1">
            <Label class="text-xs text-muted-foreground">Name</Label>
            <Input
              class="min-w-[180px]"
              value={newName()}
              onInput={(event) => setNewName(event.currentTarget.value)}
              placeholder="e.g. context7"
            />
          </div>

          <div class="flex flex-col gap-1">
            <Label class="text-xs text-muted-foreground">Type</Label>
            <select
              class={cn(
                "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "min-w-[120px]"
              )}
              value={newType()}
              onChange={(event) => setNewType(event.currentTarget.value as McpServerConfig["type"])}
            >
              <option value="local">local</option>
              <option value="remote">remote</option>
            </select>
          </div>

          <Show when={newType() === "local"}>
            <div class="flex flex-col flex-1 min-w-[280px] gap-1">
              <Label class="text-xs text-muted-foreground">Command</Label>
              <Input
                value={newCommand()}
                onInput={(event) => setNewCommand(event.currentTarget.value)}
                placeholder='npx -y @modelcontextprotocol/server-everything'
              />
            </div>
          </Show>

          <Show when={newType() === "remote"}>
            <div class="flex flex-col flex-1 min-w-[280px] gap-1">
              <Label class="text-xs text-muted-foreground">URL</Label>
              <Input
                value={newUrl()}
                onInput={(event) => setNewUrl(event.currentTarget.value)}
                placeholder="https://mcp.example.com/mcp"
              />
            </div>
          </Show>

          <Button onClick={createNewServer}>
            Add
          </Button>

          <Button variant="secondary" onClick={() => void applyAll()}>
            Apply to Running Instances
          </Button>

          <Button onClick={() => props.onAddServer?.()} title="Add a new MCP server with scope selection">
            <Plus class="w-4 h-4" />
            Add Server
          </Button>
        </div>

        <div class="space-y-3">
          <For each={entries()}>
            {(entry) => (
              <Card class={cn("px-3 py-2", entry.builtIn && "border-info/20")}>
                <div class="flex items-center justify-between gap-2">
                  <div class="flex flex-col min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-sm text-foreground font-medium truncate">{entry.name}</span>
                      <Show when={entry.source === "era-code"}>
                        <Badge variant="info" class="text-[10px] px-1.5 py-0">Era Code</Badge>
                      </Show>
                      <Show when={entry.source === "global" && scope() === "project"}>
                        <Badge variant="secondary" class="text-[10px] px-1.5 py-0">Global</Badge>
                      </Show>
                      <Show when={entry.source === "project"}>
                        <Badge variant="success" class="text-[10px] px-1.5 py-0">Project</Badge>
                      </Show>
                      <Show when={entry.hasProjectOverride}>
                        <Badge variant="warning" class="text-[10px] px-1.5 py-0">Override</Badge>
                      </Show>
                    </div>
                    <div class="text-xs text-muted-foreground truncate">
                      {entry.builtInServer?.description ?? (entry.config.type === "local" ? entry.config.command.join(" ") : entry.config.url)}
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <Show when={entry.builtIn && entry.builtInServer?.configurable}>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setConfiguringServer(configuringServer() === entry.name ? null : entry.name)}
                        title="Configure"
                      >
                        <Settings class="w-4 h-4" />
                      </Button>
                    </Show>
                    <Switch
                      checked={entry.desiredEnabled}
                      onChange={(checked) => {
                        saveEntry(entry.name, entry.config, checked)
                        void applyAll()
                      }}
                      label="Enabled"
                      class="text-xs"
                    />
                    <Show when={!entry.builtIn}>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => removeEntry(entry.name)}
                      >
                        Remove
                      </Button>
                    </Show>
                  </div>
                </div>

                {/* Configurable options panel */}
                <Show when={entry.builtIn && entry.builtInServer?.configurable && configuringServer() === entry.name}>
                  <Separator class="my-2" />
                  <div class="space-y-2 pt-1">
                    <For each={Object.entries(entry.builtInServer!.configurable!)}>
                      {([key, option]) => (
                        <div class="flex items-center gap-3">
                          <Label class="text-xs text-muted-foreground min-w-[120px]">{option.label}</Label>
                          <Show when={option.type === "number"}>
                            <Input
                              type="number"
                              class="w-24"
                              value={getBuiltInMcpOptionValue(entry.name, key) as number}
                              onInput={(e) => {
                                updateBuiltInMcpOption(entry.name, key, Number(e.currentTarget.value))
                              }}
                            />
                          </Show>
                          <Show when={option.type === "string"}>
                            <Input
                              type="text"
                              class="flex-1"
                              value={getBuiltInMcpOptionValue(entry.name, key) as string}
                              onInput={(e) => {
                                updateBuiltInMcpOption(entry.name, key, e.currentTarget.value)
                              }}
                            />
                          </Show>
                          <Show when={option.type === "boolean"}>
                            <Switch
                              checked={getBuiltInMcpOptionValue(entry.name, key) as boolean}
                              onChange={(checked) => {
                                updateBuiltInMcpOption(entry.name, key, checked)
                              }}
                            />
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Card>
            )}
          </For>
        </div>

        {/* Add to Global Modal */}
        <Show when={pendingServer()}>
          <AddToGlobalModal
            open={addToGlobalOpen()}
            onClose={() => {
              setAddToGlobalOpen(false)
              setPendingServer(null)
            }}
            type="mcp"
            serverName={pendingServer()!.name}
            serverConfig={pendingServer()!.config}
            onAddGlobal={handleAddToGlobal}
            onKeepProjectOnly={handleKeepProjectOnly}
          />
        </Show>

      </div>
    </Card>
  )
}

export default McpSettingsPanel
