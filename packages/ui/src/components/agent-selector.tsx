import { Combobox } from "@kobalte/core/combobox"
import { Show, createEffect, createMemo, createSignal } from "solid-js"
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
  const accessibleLabel = () => t("agentSelector.trigger.primary", { agent: selectedAgent()?.name || t("agentSelector.none") })
  const [isOpen, setIsOpen] = createSignal(false)
  let searchInputRef: HTMLInputElement | undefined

  createEffect(() => {
    if (instanceAgents().length === 0) {
      fetchAgents(props.instanceId).catch((error) => log.error("Failed to fetch agents", error))
    }
  })

  createEffect(() => {
    if (!isOpen()) return
    setTimeout(() => {
      searchInputRef?.focus()
      searchInputRef?.select()
    }, 0)
  })

  const handleChange = async (value: Agent | null) => {
    if (value && value.id !== props.currentAgent) {
      await props.onAgentChange(value.id)
    }
  }

  return (
    <div class="sidebar-selector">
      <Combobox<Agent>
        gutter={0}
        open={isOpen()}
        onOpenChange={setIsOpen}
        value={selectedAgent()}
        onChange={handleChange}
        options={availableAgents()}
        optionValue="id"
        optionTextValue="name"
        optionLabel="name"
        placeholder={t("agentSelector.placeholder")}
        defaultFilter={(agent, query) => `${agent.name} ${agent.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())}
        allowsEmptyCollection
        itemComponent={(itemProps) => (
          <Combobox.Item
            item={itemProps.item}
            class="selector-option"
          >
            <div class="flex flex-col flex-1 min-w-0">
              <Combobox.ItemLabel class="selector-option-label flex items-center gap-2">
                <span>{itemProps.item.rawValue.name}</span>
                <Show when={itemProps.item.rawValue.mode === "subagent"}>
                  <span class="neutral-badge">{t("agentSelector.badge.subagent")}</span>
                </Show>
              </Combobox.ItemLabel>
              <Show when={itemProps.item.rawValue.description}>
                <Combobox.ItemDescription class="selector-option-description">
                  {itemProps.item.rawValue.description.length > 50
                    ? itemProps.item.rawValue.description.slice(0, 50) + "..."
                    : itemProps.item.rawValue.description}
                </Combobox.ItemDescription>
              </Show>
            </div>
          </Combobox.Item>
        )}
      >
        <Combobox.Control class="relative w-full">
          <Combobox.Input class="sr-only" data-agent-selector aria-label={t("agentSelector.placeholder")} />
          <Combobox.Trigger class="selector-trigger" aria-label={accessibleLabel()} title={accessibleLabel()}>
            <div class="flex-1 min-w-0">
              <div class="selector-trigger-label selector-trigger-label--stacked">
                <span class="selector-trigger-primary selector-trigger-primary--align-left">
                  <span class="session-sidebar-selector-prefix">{t("agentSelector.trigger.primary", { agent: "" }).trim()}</span>{" "}
                  {selectedAgent()?.name || t("agentSelector.none")}
                </span>
              </div>
            </div>
            <Combobox.Icon class="selector-trigger-icon">
              <ChevronDown class="w-3 h-3" />
            </Combobox.Icon>
          </Combobox.Trigger>
        </Combobox.Control>

        <Combobox.Portal>
          <Combobox.Content class="selector-popover session-sidebar-selector-popover">
            <div class="selector-search-container">
              <Combobox.Input
                ref={searchInputRef}
                class="selector-search-input"
                placeholder={t("agentSelector.placeholder")}
              />
            </div>
            <Combobox.Listbox class="selector-listbox" />
          </Combobox.Content>
        </Combobox.Portal>
      </Combobox>
    </div>
  )
}
