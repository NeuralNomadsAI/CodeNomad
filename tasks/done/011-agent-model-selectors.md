# Task 011: Agent and Model Selectors

## Goal

Implement dropdown selectors for switching agents and models in the active session. These controls appear in the control bar above the prompt input and allow users to change the agent or model for the current conversation.

## Prerequisites

- Task 010 (Tool Call Rendering) completed
- Session state management implemented
- SDK client integration functional
- UI components library (Kobalte) configured

## Acceptance Criteria

- [x] Agent selector dropdown displays current agent
- [x] Agent dropdown lists all available agents
- [x] Selecting agent updates session configuration
- [x] Model selector dropdown displays current model
- [x] Model dropdown lists all available models (flat list with provider name shown)
- [x] Selecting model updates session configuration
- [x] Changes persist across app restarts (stored in session state)
- [x] Loading states during fetch/update (automatic via createEffect)
- [x] Error handling for failed updates (logged to console)
- [x] Keyboard navigation works (provided by Kobalte Select)
- [x] Visual feedback on selection change

## Implementation Notes

**Completed:** All acceptance criteria met with the following implementation details:

1. **Agent Selector** (`src/components/agent-selector.tsx`):
   - Uses Kobalte Select component for accessibility
   - Fetches agents via `fetchAgents()` on mount
   - Displays agent name and description
   - Light mode styling matching the rest of the app
   - Compact size (text-xs, smaller padding) for bottom placement
   - Updates session state locally (agent/model are sent with each prompt, not via separate update API)

2. **Model Selector** (`src/components/model-selector.tsx`):
   - Uses Kobalte Select component for accessibility
   - Fetches providers and models via `fetchProviders()` on mount
   - Flattens model list from all providers for easier selection
   - Shows provider name alongside model name
   - **Search functionality** - inline search input at top of dropdown
   - Filters models by name, provider name, or model ID
   - Shows "No models found" message when no matches
   - Clears search query when model is selected
   - Light mode styling matching the rest of the app
   - Compact size (text-xs, smaller padding) for bottom placement
   - Updates session state locally

3. **Integration** (`src/components/prompt-input.tsx`):
   - Integrated selectors directly into prompt input hints area
   - Positioned bottom right, on same line as "Enter to send" hint
   - Removed separate controls-bar component for cleaner integration
   - Passes agent/model props and change handlers from parent

4. **Session Store Updates** (`src/stores/sessions.ts`):
   - Added `updateSessionAgent()` - updates session agent locally
   - Added `updateSessionModel()` - updates session model locally
   - Note: The SDK doesn't support updating agent/model via separate API calls
   - Agent and model are sent with each prompt via the `sendMessage()` function

5. **Integration** (`src/App.tsx`):
   - Passes agent, model, and change handlers to PromptInput
   - SessionView component updated with new props

**Design Decisions:**

- Simplified model selector to use flat list instead of grouped (Kobalte 0.13.11 Select doesn't support groups)
- Agent and model changes are stored locally and sent with each prompt request
- No separate API call to update session configuration (matches SDK limitations)
- Used SolidJS's `createEffect` for automatic data fetching on component mount
- Integrated controls into prompt input area rather than separate bar for better space usage
- Positioned bottom right on hints line for easy access without obscuring content
- Light mode only styling (removed dark mode classes) to match existing app design
- Compact sizing (text-xs, reduced padding) to fit naturally in the hints area
- Search input with icon in sticky header at top of model dropdown
- Real-time filtering across model name, provider name, and model ID
- Search preserves dropdown open state and clears on selection

## Steps

### 1. Define Types

Create `src/types/config.ts`:

```typescript
interface Agent {
  id: string
  name: string
  description: string
}

interface Model {
  providerId: string
  modelId: string
  name: string
  contextWindow?: number
  capabilities?: string[]
}

interface ModelProvider {
  id: string
  name: string
  models: Model[]
}
```

### 2. Fetch Available Options

Extend SDK hooks in `src/hooks/use-session.ts`:

```typescript
function useAgents(instanceId: string) {
  const [agents, setAgents] = createSignal<Agent[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<Error | null>(null)

  createEffect(() => {
    const client = getClient(instanceId)
    if (!client) return

    setLoading(true)
    client.config
      .agents()
      .then(setAgents)
      .catch(setError)
      .finally(() => setLoading(false))
  })

  return { agents, loading, error }
}

function useModels(instanceId: string) {
  const [providers, setProviders] = createSignal<ModelProvider[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<Error | null>(null)

  createEffect(() => {
    const client = getClient(instanceId)
    if (!client) return

    setLoading(true)
    client.config
      .models()
      .then((data) => {
        // Group models by provider
        const grouped = groupModelsByProvider(data)
        setProviders(grouped)
      })
      .catch(setError)
      .finally(() => setLoading(false))
  })

  return { providers, loading, error }
}
```

### 3. Create Agent Selector Component

Create `src/components/agent-selector.tsx`:

```typescript
import { Select } from '@kobalte/core'
import { createMemo } from 'solid-js'
import { useAgents } from '../hooks/use-session'

interface AgentSelectorProps {
  instanceId: string
  sessionId: string
  currentAgent: string
  onAgentChange: (agent: string) => void
}

export function AgentSelector(props: AgentSelectorProps) {
  const { agents, loading, error } = useAgents(props.instanceId)

  const currentAgentInfo = createMemo(() =>
    agents().find(a => a.id === props.currentAgent)
  )

  return (
    <Select.Root
      value={props.currentAgent}
      onChange={props.onAgentChange}
      options={agents()}
      optionValue="id"
      optionTextValue="name"
      placeholder="Select agent..."
      itemComponent={props => (
        <Select.Item item={props.item} class="px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer">
          <Select.ItemLabel class="font-medium">{props.item.rawValue.name}</Select.ItemLabel>
          <Select.ItemDescription class="text-sm text-gray-600 dark:text-gray-400">
            {props.item.rawValue.description}
          </Select.ItemDescription>
        </Select.Item>
      )}
    >
      <Select.Trigger class="inline-flex items-center justify-between px-4 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800">
        <Select.Value<Agent>>
          {state => (
            <span class="text-sm">
              Agent: {state.selectedOption()?.name ?? 'Select...'}
            </span>
          )}
        </Select.Value>
        <Select.Icon class="ml-2">
          <ChevronDownIcon class="w-4 h-4" />
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content class="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md shadow-lg max-h-80 overflow-auto">
          <Select.Listbox />
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
```

### 4. Create Model Selector Component

Create `src/components/model-selector.tsx`:

```typescript
import { Select } from '@kobalte/core'
import { For, createMemo } from 'solid-js'
import { useModels } from '../hooks/use-session'

interface ModelSelectorProps {
  instanceId: string
  sessionId: string
  currentModel: { providerId: string; modelId: string }
  onModelChange: (model: { providerId: string; modelId: string }) => void
}

export function ModelSelector(props: ModelSelectorProps) {
  const { providers, loading, error } = useModels(props.instanceId)

  const allModels = createMemo(() =>
    providers().flatMap(p => p.models.map(m => ({ ...m, provider: p.name })))
  )

  const currentModelInfo = createMemo(() =>
    allModels().find(
      m => m.providerId === props.currentModel.providerId &&
           m.modelId === props.currentModel.modelId
    )
  )

  return (
    <Select.Root
      value={`${props.currentModel.providerId}/${props.currentModel.modelId}`}
      onChange={value => {
        const [providerId, modelId] = value.split('/')
        props.onModelChange({ providerId, modelId })
      }}
      options={allModels()}
      optionValue={m => `${m.providerId}/${m.modelId}`}
      optionTextValue="name"
      placeholder="Select model..."
      itemComponent={props => (
        <Select.Item
          item={props.item}
          class="px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
        >
          <Select.ItemLabel class="font-medium">
            {props.item.rawValue.name}
          </Select.ItemLabel>
          <Select.ItemDescription class="text-xs text-gray-600 dark:text-gray-400">
            {props.item.rawValue.provider}
            {props.item.rawValue.contextWindow &&
              ` • ${(props.item.rawValue.contextWindow / 1000).toFixed(0)}k context`
            }
          </Select.ItemDescription>
        </Select.Item>
      )}
    >
      <Select.Trigger class="inline-flex items-center justify-between px-4 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800">
        <Select.Value<Model>>
          {state => (
            <span class="text-sm">
              Model: {state.selectedOption()?.name ?? 'Select...'}
            </span>
          )}
        </Select.Value>
        <Select.Icon class="ml-2">
          <ChevronDownIcon class="w-4 h-4" />
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content class="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md shadow-lg max-h-80 overflow-auto">
          <For each={providers()}>
            {provider => (
              <>
                <Select.Group>
                  <Select.GroupLabel class="px-3 py-1 text-xs font-semibold text-gray-500 dark:text-gray-500 uppercase">
                    {provider.name}
                  </Select.GroupLabel>
                  <For each={provider.models}>
                    {model => (
                      <Select.Item
                        value={`${model.providerId}/${model.modelId}`}
                        class="px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
                      >
                        <Select.ItemLabel>{model.name}</Select.ItemLabel>
                      </Select.Item>
                    )}
                  </For>
                </Select.Group>
              </>
            )}
          </For>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
```

### 5. Create Controls Bar Component

Create `src/components/controls-bar.tsx`:

```typescript
import { AgentSelector } from './agent-selector'
import { ModelSelector } from './model-selector'

interface ControlsBarProps {
  instanceId: string
  sessionId: string
  currentAgent: string
  currentModel: { providerId: string; modelId: string }
  onAgentChange: (agent: string) => Promise<void>
  onModelChange: (model: { providerId: string; modelId: string }) => Promise<void>
}

export function ControlsBar(props: ControlsBarProps) {
  const handleAgentChange = async (agent: string) => {
    try {
      await props.onAgentChange(agent)
    } catch (error) {
      console.error('Failed to change agent:', error)
      // Show error toast
    }
  }

  const handleModelChange = async (model: { providerId: string; modelId: string }) => {
    try {
      await props.onModelChange(model)
    } catch (error) {
      console.error('Failed to change model:', error)
      // Show error toast
    }
  }

  return (
    <div class="flex items-center gap-4 px-4 py-2 border-t border-gray-200 dark:border-gray-800">
      <AgentSelector
        instanceId={props.instanceId}
        sessionId={props.sessionId}
        currentAgent={props.currentAgent}
        onAgentChange={handleAgentChange}
      />
      <ModelSelector
        instanceId={props.instanceId}
        sessionId={props.sessionId}
        currentModel={props.currentModel}
        onModelChange={handleModelChange}
      />
    </div>
  )
}
```

### 6. Add Update Methods to Session Hook

Extend `src/hooks/use-session.ts`:

```typescript
async function updateSessionAgent(instanceId: string, sessionId: string, agent: string) {
  const client = getClient(instanceId)
  if (!client) throw new Error("Client not found")

  await client.session.update(sessionId, { agent })

  // Update local state
  const session = getSession(instanceId, sessionId)
  if (session) {
    session.agent = agent
  }
}

async function updateSessionModel(
  instanceId: string,
  sessionId: string,
  model: { providerId: string; modelId: string },
) {
  const client = getClient(instanceId)
  if (!client) throw new Error("Client not found")

  await client.session.update(sessionId, { model })

  // Update local state
  const session = getSession(instanceId, sessionId)
  if (session) {
    session.model = model
  }
}
```

### 7. Integrate into Main Layout

Update the session view component to include controls bar:

```typescript
function SessionView(props: { instanceId: string; sessionId: string }) {
  const session = () => getSession(props.instanceId, props.sessionId)

  return (
    <div class="flex flex-col h-full">
      {/* Messages area */}
      <div class="flex-1 overflow-auto">
        <MessageStream
          instanceId={props.instanceId}
          sessionId={props.sessionId}
        />
      </div>

      {/* Controls bar */}
      <ControlsBar
        instanceId={props.instanceId}
        sessionId={props.sessionId}
        currentAgent={session()?.agent}
        currentModel={session()?.model}
        onAgentChange={agent => updateSessionAgent(props.instanceId, props.sessionId, agent)}
        onModelChange={model => updateSessionModel(props.instanceId, props.sessionId, model)}
      />

      {/* Prompt input */}
      <PromptInput
        instanceId={props.instanceId}
        sessionId={props.sessionId}
      />
    </div>
  )
}
```

### 8. Add Loading and Error States

Enhance selectors with loading states:

```typescript
// In AgentSelector
<Show when={loading()}>
  <div class="px-4 py-2 text-sm text-gray-500">Loading agents...</div>
</Show>

<Show when={error()}>
  <div class="px-4 py-2 text-sm text-red-500">
    Failed to load agents: {error()?.message}
  </div>
</Show>
```

### 9. Style Dropdowns

Add Tailwind classes for:

- Dropdown trigger button
- Dropdown content panel
- Option items
- Hover states
- Selected state
- Keyboard focus states
- Dark mode variants

### 10. Add Keyboard Navigation

Ensure Kobalte Select handles:

- Arrow up/down: Navigate options
- Enter: Select option
- Escape: Close dropdown
- Tab: Move to next control

## Verification Steps

1. Launch app with an active session
2. Verify current agent displays in selector
3. Click agent selector
4. Verify dropdown opens with agent list
5. Select different agent
6. Verify session updates (check network request)
7. Verify selector shows new agent
8. Repeat for model selector
9. Test keyboard navigation
10. Test with long agent/model names
11. Test error state (disconnect network)
12. Test loading state (slow network)
13. Verify changes persist on session switch
14. Verify changes persist on app restart

## Dependencies for Next Tasks

- Task 012 (Markdown Rendering) can proceed independently
- Task 013 (Logs Tab) can proceed independently
- This completes session configuration UI

## Estimated Time

3-4 hours

## Notes

- Use Kobalte Select component for accessibility
- Group models by provider for better UX
- Show relevant model metadata (context window, capabilities)
- Consider caching agents/models list per instance
- Handle case where current agent/model is no longer available
- Future: Add search/filter for large model lists
- Future: Show model pricing information
