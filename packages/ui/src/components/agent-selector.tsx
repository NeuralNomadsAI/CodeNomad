import { Select } from "@kobalte/core/select"
import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { agents, fetchAgents, sessions, upsertAgent } from "../stores/sessions"
import { ChevronDown } from "lucide-solid"
import type { Agent } from "../types/session"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { serverApi } from "../lib/api-client"
import { showToastNotification } from "../lib/notifications"
const log = getLogger("session")


interface AgentSelectorProps {
  instanceId: string
  sessionId: string
  currentAgent: string
  onAgentChange: (agent: string) => Promise<void>
}

export default function AgentSelector(props: AgentSelectorProps) {
  const { t } = useI18n()
  const [newAgentName, setNewAgentName] = createSignal("")
  const [newAgentDescription, setNewAgentDescription] = createSignal("")
  const [newAgentPrompt, setNewAgentPrompt] = createSignal("")
  const [isCreatingAgent, setIsCreatingAgent] = createSignal(false)
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
      return allAgents.filter((agent) => !agent.hidden)
    }

    const filtered = allAgents.filter((agent) => !agent.hidden && agent.mode !== "subagent")

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

  const normalizedNewAgentName = createMemo(() => newAgentName().trim())
  const isNewAgentNameValid = createMemo(() => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalizedNewAgentName()))
  const canCreateAgent = createMemo(() => isNewAgentNameValid() && !isCreatingAgent())

  const quoteYamlString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

  const buildAgentMarkdown = (name: string) => {
    const description = newAgentDescription().trim() || t("agentSelector.add.defaultDescription", { agent: name })
    const prompt = newAgentPrompt().trim() || t("agentSelector.add.defaultPrompt", { agent: name })
    return [
      "---",
      `description: ${quoteYamlString(description)}`,
      "mode: primary",
      "---",
      prompt,
      "",
    ].join("\n")
  }

  const handleCreateAgent = async (event: SubmitEvent) => {
    event.preventDefault()
    const name = normalizedNewAgentName()
    if (!isNewAgentNameValid()) {
      showToastNotification({ message: t("agentSelector.add.invalidName"), variant: "error" })
      return
    }
    if (instanceAgents().some((agent) => agent.name === name)) {
      showToastNotification({ message: t("agentSelector.add.duplicate", { agent: name }), variant: "error" })
      return
    }

    setIsCreatingAgent(true)
    try {
      const description = newAgentDescription().trim() || t("agentSelector.add.defaultDescription", { agent: name })
      const filePath = `.opencode/agents/${name}.md`
      try {
        await serverApi.readWorkspaceFile(props.instanceId, filePath)
        showToastNotification({ message: t("agentSelector.add.fileExists", { agent: name }), variant: "error" })
        return
      } catch {
        // New project agents should not already have a matching file.
      }

      await serverApi.writeWorkspaceFile(props.instanceId, filePath, buildAgentMarkdown(name))
      await fetchAgents(props.instanceId)
      upsertAgent(props.instanceId, { name, description, mode: "primary" })
      await props.onAgentChange(name)
      setNewAgentName("")
      setNewAgentDescription("")
      setNewAgentPrompt("")
      showToastNotification({ message: t("agentSelector.add.success", { agent: name }), variant: "success" })
    } catch (error) {
      log.error("Failed to create agent", error)
      showToastNotification({ message: t("agentSelector.add.error"), variant: "error" })
    } finally {
      setIsCreatingAgent(false)
    }
  }

  return (
    <div class="sidebar-selector">
      <Select
        value={availableAgents().find((a) => a.name === props.currentAgent)}
        onChange={handleChange}
        options={availableAgents()}
        optionValue="name"
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
                    {t("agentSelector.trigger.primary", { agent: props.currentAgent || t("agentSelector.none") })}
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
            <form
              class="selector-footer mt-1 p-2 space-y-2"
              onSubmit={handleCreateAgent}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <div class="selector-section-title">{t("agentSelector.add.title")}</div>
              <input
                class="selector-input w-full"
                value={newAgentName()}
                onInput={(event) => setNewAgentName(event.currentTarget.value)}
                placeholder={t("agentSelector.add.name.placeholder")}
                aria-label={t("agentSelector.add.name.ariaLabel")}
              />
              <input
                class="selector-input w-full"
                value={newAgentDescription()}
                onInput={(event) => setNewAgentDescription(event.currentTarget.value)}
                placeholder={t("agentSelector.add.description.placeholder")}
                aria-label={t("agentSelector.add.description.ariaLabel")}
              />
              <textarea
                class="selector-input w-full min-h-20 resize-y"
                value={newAgentPrompt()}
                onInput={(event) => setNewAgentPrompt(event.currentTarget.value)}
                placeholder={t("agentSelector.add.prompt.placeholder")}
                aria-label={t("agentSelector.add.prompt.ariaLabel")}
              />
              <button
                type="submit"
                class="selector-button selector-button-primary"
                disabled={!canCreateAgent()}
              >
                {isCreatingAgent() ? t("agentSelector.add.creating") : t("agentSelector.add.action")}
              </button>
              <Show when={normalizedNewAgentName() && !isNewAgentNameValid()}>
                <p class="selector-validation-error-text">{t("agentSelector.add.name.help")}</p>
              </Show>
            </form>
          </Select.Content>
        </Select.Portal>
      </Select>
    </div>
  )
}
