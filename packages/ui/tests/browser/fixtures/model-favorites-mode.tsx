import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import type { Model } from "../../../src/types/session"
import "../../../src/index.css"

// The preferences store loads itself as soon as it is imported, so the API
// double has to be installed before any store module is pulled in.
const { serverApi } = await import("../../../src/lib/api-client")

const instanceId = "model-favorites"
const sessionId = "session"
const writes: unknown[] = []
const calls: string[] = []

const state: { models: { favorites: { providerId: string; modelId: string }[]; favoritesOnly: boolean } } = {
  models: { favorites: [{ providerId: "openai", modelId: "gpt-6-astra" }, { providerId: "openai", modelId: "gpt-6-sol" }], favoritesOnly: false },
}
const merge = (target: any, patch: any) => {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) merge(target[key] ??= {}, value)
    else target[key] = value
  }
  return target
}

serverApi.fetchConfigOwner = (async (owner: string) => { calls.push(`fetchConfigOwner:${owner}`); return owner === "ui" ? { settings: { locale: "en" } } : {} }) as any
serverApi.patchConfigOwner = (async (owner: string, patch: any) => { calls.push(`patchConfigOwner:${owner}`); return owner === "ui" ? merge({ settings: { locale: "en" } }, patch) : {} }) as any
serverApi.fetchStateOwner = (async (owner: string) => { calls.push(`fetchStateOwner:${owner}`); return owner === "ui" ? structuredClone(state) : {} }) as any
serverApi.patchStateOwner = (async (owner: string, patch: any) => {
  calls.push(`patchStateOwner:${owner}`)
  writes.push(JSON.parse(JSON.stringify(patch)))
  return owner === "ui" ? structuredClone(merge(state, patch)) : {}
}) as any

const [{ default: ModelSelector }, { ConfigProvider, uiState }, { I18nProvider }, { setProviders }] = await Promise.all([
  import("../../../src/components/model-selector"),
  import("../../../src/stores/preferences"),
  import("../../../src/lib/i18n"),
  import("../../../src/stores/session-state"),
])

const models: Model[] = [
  { id: "gpt-6-astra", name: "GPT-6 Astra", providerId: "openai" },
  { id: "gpt-6-sol", name: "GPT-6 Sol", providerId: "openai" },
  { id: "muse-spark", name: "Muse Spark", providerId: "zen" },
  { id: "zen-other", name: "Zen Other", providerId: "zen" },
]
setProviders(new Map([[instanceId, [
  { id: "openai", name: "OpenAI", models: models.filter((model) => model.providerId === "openai") },
  { id: "zen", name: "OpenCode Zen", models: models.filter((model) => model.providerId === "zen") },
]]]))

const [current, setCurrent] = createSignal({ providerId: "zen", modelId: "zen-other" })
const [generation, setGeneration] = createSignal(0)
const changes: { providerId: string; modelId: string }[] = []

function Fixture() {
  return (
    <ConfigProvider>
      <I18nProvider>
        <button id="pick-favorite" onClick={() => setCurrent({ providerId: "openai", modelId: "gpt-6-astra" })}>favorite</button>
        <button id="pick-non-favorite" onClick={() => setCurrent({ providerId: "zen", modelId: "zen-other" })}>non favorite</button>
        <button id="remount" onClick={() => setGeneration((value) => value + 1)}>remount</button>
        <Show when={generation() >= 0}>
          <ModelSelector
            instanceId={instanceId}
            sessionId={sessionId}
            currentModel={current()}
            onModelChange={async (model) => { changes.push(model); setCurrent(model) }}
          />
        </Show>
        <output id="changes">{changes.length}</output>
      </I18nProvider>
    </ConfigProvider>
  )
}

render(() => <Fixture />, document.getElementById("root")!)
;(window as any).fixture = {
  writes: () => writes,
  calls: () => calls,
  state: () => state,
  uiState: () => uiState(),
}
