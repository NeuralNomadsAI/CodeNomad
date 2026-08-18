import { Select } from "@kobalte/core/select"
import { Show, createEffect, createMemo } from "solid-js"
import { agents, fetchAgents, sessions } from "../stores/sessions"
import { ChevronDown } from "lucide-solid"
import { findAgentById, getSelectableAgentsForSession, type Agent } from "../types/session"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
const log = getLogger("session")


interface AgentSelectorProps {
  instanceId: string
  sessionId: string
  currentAgent: string
  onAgentChange: (agent: string) => Promise<void>
}

export default function AgentSelector(props: AgentSelectorProps) {
  const { t } = useI18n()
  const instanceAgents = () => agents().get(props.instanceId) || []

  const session = createMemo(() => {
    const instanceSessions = sessions().get(props.instanceId)
    return instanceSessions?.get(props.sessionId)
  })

  const isChildSession = createMemo(() => {
    return session()?.parentId !== null && session()?.parentId !== undefined
  })

  const availableAgents = createMemo(() => {
    return getSelectableAgentsForSession(instanceAgents(), props.currentAgent, isChildSession())
  })
  const selectedAgent = createMemo(() => findAgentById(availableAgents(), props.currentAgent))

  createEffect(() => {
    if (instanceAgents().length === 0) {
      fetchAgents(props.instanceId).catch((error) => log.error("Failed to fetch agents", error))
    }
  })

  const handleChange = async (value: Agent | null) => {
    if (value && value.id !== props.currentAgent) {
      await props.onAgentChange(value.id)
    }
  }

  return (
    <div class="sidebar-selector">
      <Select
        value={selectedAgent()}
        onChange={handleChange}
        options={availableAgents()}
        optionValue="id"
        optionTextValue="name"
        placeholder={t("agentSelector.placeholder")}
        itemComponent={(itemProps) => (
          <Select.Item
            item={itemProps.item}
            class="selector-option"
          >
            <div class="flex flex-col flex-1 min-w-0">
              <Select.ItemLabel class="selector-option-label flex items-center gap-2">
                <span>{itemProps.item.rawValue.name}</span>
                <Show when={itemProps.item.rawValue.mode === "subagent"}>
                  <span class="neutral-badge">{t("agentSelector.badge.subagent")}</span>
                </Show>
              </Select.ItemLabel>
              <Show when={itemProps.item.rawValue.description}>
                <Select.ItemDescription class="selector-option-description">
                  {itemProps.item.rawValue.description.length > 50
                    ? itemProps.item.rawValue.description.slice(0, 50) + "..."
                    : itemProps.item.rawValue.description}
                </Select.ItemDescription>
              </Show>
            </div>
          </Select.Item>
        )}
      >
        <Select.Trigger
          data-agent-selector
          class="selector-trigger"
        >
          <div class="flex-1 min-w-0">
            <Select.Value<Agent>>
              {() => (
                <div class="selector-trigger-label selector-trigger-label--stacked">
                  <span class="selector-trigger-primary selector-trigger-primary--align-left">
                    {t("agentSelector.trigger.primary", { agent: selectedAgent()?.name || t("agentSelector.none") })}
                  </span>
                </div>
              )}
            </Select.Value>
          </div>
          <Select.Icon class="selector-trigger-icon">
            <ChevronDown class="w-3 h-3" />
          </Select.Icon>
        </Select.Trigger>

        <Select.Portal>
          <Select.Content class="selector-popover max-h-80 overflow-auto p-1">
            <Select.Listbox class="selector-listbox" />
          </Select.Content>
        </Select.Portal>
      </Select>
    </div>
  )
}
