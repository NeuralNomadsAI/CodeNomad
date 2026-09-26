import { createSignal, onCleanup, onMount, Show } from "solid-js"
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
let latency = 0

const options = new URLSearchParams(location.search)
const state: { models: { favorites: { providerId: string; modelId: string }[]; favoritesOnly: boolean } } = {
  models: {
    favorites: options.get("favorites") === "none"
      ? []
      : [{ providerId: "openai", modelId: "gpt-6-astra" }, { providerId: "openai", modelId: "gpt-6-sol" }],
    favoritesOnly: options.get("mode") === "favorites",
  },
}
const config: { settings: Record<string, any> } = { settings: { locale: "en" } }
const merge = (target: any, patch: any) => {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) merge(target[key] ??= {}, value)
    else target[key] = value
  }
  return target
}
const wait = () => latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : undefined

serverApi.fetchConfigOwner = (async (owner: string) => { calls.push(`fetchConfigOwner:${owner}`); return owner === "ui" ? structuredClone(config) : {} }) as any
serverApi.patchConfigOwner = (async (owner: string, patch: any) => {
  calls.push(`patchConfigOwner:${owner}`)
  await wait()
  return owner === "ui" ? structuredClone(merge(config, patch)) : {}
}) as any
serverApi.fetchStateOwner = (async (owner: string) => { calls.push(`fetchStateOwner:${owner}`); return owner === "ui" ? structuredClone(state) : {} }) as any
serverApi.patchStateOwner = (async (owner: string, patch: any) => {
  calls.push(`patchStateOwner:${owner}`)
  writes.push(JSON.parse(JSON.stringify(patch)))
  await wait()
  return owner === "ui" ? structuredClone(merge(state, patch)) : {}
}) as any

const [
  { default: ModelSelector },
  { ConfigProvider, uiState, setProviderModelVisibility, getFavoritesOnlyPreference },
  { I18nProvider },
  { setProviders },
] = await Promise.all([
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
const [mounted, setMounted] = createSignal(true)
const changes: { providerId: string; modelId: string }[] = []
let mounts = 0
let cleanups = 0

function MountedSelector() {
  onMount(() => { mounts += 1 })
  onCleanup(() => { cleanups += 1 })
  return (
    <ModelSelector
      instanceId={instanceId}
      sessionId={sessionId}
      currentModel={current()}
      onModelChange={async (model) => { changes.push(model); setCurrent(model) }}
    />
  )
}

function Fixture() {
  return (
    <ConfigProvider>
      <I18nProvider>
        <button id="pick-favorite" onClick={() => setCurrent({ providerId: "openai", modelId: "gpt-6-astra" })}>favorite</button>
        <button id="pick-non-favorite" onClick={() => setCurrent({ providerId: "zen", modelId: "zen-other" })}>non favorite</button>
        <button id="remount" onClick={() => { setMounted(false); setTimeout(() => setMounted(true), 0) }}>remount</button>
        <Show when={mounted()}>
          <MountedSelector />
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
  mounts: () => mounts,
  cleanups: () => cleanups,
  mode: () => getFavoritesOnlyPreference(),
  setLatency: (milliseconds: number) => { latency = milliseconds },
  hideModel: (providerId: string, modelId: string) => setProviderModelVisibility(providerId, { hiddenModelIds: [modelId] }),
}
