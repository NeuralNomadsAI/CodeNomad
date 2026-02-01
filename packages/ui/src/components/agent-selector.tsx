import { Select } from "@kobalte/core/select"
import { For, Show, createEffect, createMemo } from "solid-js"
import { agents, fetchAgents, sessions } from "../stores/sessions"
import { ChevronDown } from "lucide-solid"
import type { Agent } from "../types/session"
import { getLogger } from "../lib/logger"
import { cn } from "../lib/cn"
const log = getLogger("session")

const INTERNAL_AGENT_NAMES = new Set(["compaction", "title", "summary"])

interface AgentSelectorProps {
  instanceId: string
  sessionId: string
  currentAgent: string
  onAgentChange: (agent: string) => Promise<void>
}

export default function AgentSelector(props: AgentSelectorProps) {
  const instanceAgents = () => agents().get(props.instanceId) || []

  const session = createMemo(() => {
    const instanceSessions = sessions().get(props.instanceId)
    return instanceSessions?.get(props.sessionId)
  })

  const isChildSession = createMemo(() => {
    return session()?.parentId !== null && session()?.parentId !== undefined
  })

  const availableAgents = createMemo(() => {
    const allAgents = instanceAgents()
    if (isChildSession()) {
      return allAgents
    }

    const filtered = allAgents.filter(
      (agent) => agent.mode !== "subagent" && !INTERNAL_AGENT_NAMES.has(agent.name),
    )

    const currentAgent = allAgents.find((a) => a.name === props.currentAgent)
    if (currentAgent && !filtered.find((a) => a.name === props.currentAgent)) {
      return [currentAgent, ...filtered]
    }

    return filtered
  })

  createEffect(() => {
    const list = availableAgents()
    if (list.length === 0) return
    if (!list.some((agent) => agent.name === props.currentAgent)) {
      void props.onAgentChange(list[0].name)
    }
  })

  createEffect(() => {
    if (instanceAgents().length === 0) {
      fetchAgents(props.instanceId).catch((error) => log.error("Failed to fetch agents", error))
    }
  })


  const handleChange = async (value: Agent | null) => {
    if (value && value.name !== props.currentAgent) {
      await props.onAgentChange(value.name)
    }
  }

  const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)

  return (
    <div class="flex flex-col gap-1.5 w-full">
      <label class="text-xs font-semibold uppercase tracking-wide block text-muted-foreground">Agent</label>
      <Select
        value={availableAgents().find((a) => a.name === props.currentAgent)}
        onChange={handleChange}
        options={availableAgents()}
        optionValue={(option: Agent | null | undefined) => option?.name ?? ""}
        optionTextValue={(option: Agent | null | undefined) => option?.name ?? ""}
        placeholder="Select agent..."
        itemComponent={(itemProps) => {
          const agent = itemProps.item.rawValue as Agent | undefined
          return (
            <Select.Item
              item={itemProps.item}
              class="px-3 py-2 cursor-pointer rounded outline-none transition-colors flex items-start gap-2 w-full text-foreground hover:bg-accent data-[highlighted]:bg-accent data-[focused]:bg-accent data-[selected]:bg-accent"
            >
              <div class="flex flex-col flex-1 min-w-0">
                <Select.ItemLabel class="font-medium text-sm text-foreground flex items-center gap-2">
                  <span>{capitalize(agent?.name ?? "Unknown")}</span>
                  <Show when={agent?.mode === "subagent"}>
                    <span class="neutral-badge">subagent</span>
                  </Show>
                </Select.ItemLabel>
                <Show when={agent?.description}>
                  <Select.ItemDescription class="text-xs text-muted-foreground">
                    {agent?.description}
                  </Select.ItemDescription>
                </Show>
              </div>
            </Select.Item>
          )
        }}
      >
        <Select.Trigger
          data-agent-selector
          class="w-full inline-flex items-center justify-between gap-2 px-2 py-1.5 border rounded outline-none transition-colors text-xs bg-background border-border text-foreground hover:bg-accent focus:ring-2 focus:ring-info"
        >
          <Select.Value<Agent>>
            {(state) => (
              <div class="flex flex-col min-w-0">
                <span class="text-sm font-medium truncate text-foreground">
                  {capitalize(state.selectedOption()?.name ?? "None")}
                </span>
              </div>
            )}
          </Select.Value>
          <Select.Icon class="flex-shrink-0 text-muted-foreground">
            <ChevronDown class="w-3 h-3" />
          </Select.Icon>
        </Select.Trigger>

        <Select.Portal>
          <Select.Content class="rounded-md shadow-lg overflow-hidden min-w-[300px] bg-background border border-border z-[2200] max-h-80 overflow-auto p-1">
            <Select.Listbox class="max-h-64 overflow-auto p-1 bg-background" />
          </Select.Content>
        </Select.Portal>
      </Select>
    </div>
  )
}
