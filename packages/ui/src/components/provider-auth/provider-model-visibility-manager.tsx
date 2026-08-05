import { VList } from "virtua/solid"
import { ArrowLeft } from "lucide-solid"
import { createEffect, createMemo, createSignal, on, onMount, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import {
  getUnavailableSelectedModelIds,
  normalizeModelVisibilityPreference,
  seedCustomModelVisibility,
  type ModelVisibilityPreference,
} from "../../lib/model-visibility"
import { useConfig } from "../../stores/preferences"

export interface ProviderVisibilityModel {
  id: string
  name: string
}

interface ProviderModelVisibilityManagerProps {
  providerId: string
  providerName: string
  models: readonly ProviderVisibilityModel[]
  onBack: () => void
}

const compareModel = (left: ProviderVisibilityModel, right: ProviderVisibilityModel) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
  left.id.localeCompare(right.id, undefined, { sensitivity: "base" })

export const ProviderModelVisibilityManager: Component<ProviderModelVisibilityManagerProps> = (props) => {
  const { t } = useI18n()
  const {
    getProviderModelVisibilityPreference,
    providerModelVisibilitySaveFailed,
    setProviderModelVisibility,
  } = useConfig()
  const [query, setQuery] = createSignal("")
  const [preference, setPreference] = createSignal<ModelVisibilityPreference>({ mode: "all" })
  const headingId = "provider-model-visibility-heading"
  let searchInput: HTMLInputElement | undefined

  const models = createMemo(() => [...props.models].sort(compareModel))
  const modelIds = createMemo(() => models().map((model) => model.id))
  const selectedIds = createMemo(() => {
    const saved = preference()
    return new Set(saved.mode === "custom" ? saved.modelIds : modelIds())
  })
  const selectedCurrentCount = createMemo(() => modelIds().filter((id) => selectedIds().has(id)).length)
  const unavailableCount = createMemo(() =>
    getUnavailableSelectedModelIds(preference(), modelIds()).length,
  )
  const filteredModels = createMemo(() => {
    const value = query().trim().toLocaleLowerCase()
    if (!value) return models()
    return models().filter((model) =>
      model.name.toLocaleLowerCase().includes(value) || model.id.toLocaleLowerCase().includes(value),
    )
  })

  createEffect(on(() => props.providerId, (providerId) => {
    setQuery("")
    setPreference(getProviderModelVisibilityPreference(providerId))
  }))

  createEffect(() => {
    setPreference(getProviderModelVisibilityPreference(props.providerId))
  })

  onMount(() => queueMicrotask(() => searchInput?.focus()))

  const save = (next: ModelVisibilityPreference) => {
    const normalized = normalizeModelVisibilityPreference(next)
    setPreference(normalized)
    void setProviderModelVisibility(props.providerId, normalized).catch(() => undefined)
  }

  const setMode = (mode: "all" | "custom") => {
    if (mode === "all") {
      save({ mode: "all" })
    } else if (preference().mode !== "custom") {
      save(seedCustomModelVisibility(modelIds()))
    }
  }

  const selectAll = () => {
    const saved = preference()
    const unavailable = saved.mode === "custom" ? getUnavailableSelectedModelIds(saved, modelIds()) : []
    save(seedCustomModelVisibility([...modelIds(), ...unavailable]))
  }

  const toggleModel = (modelId: string, checked: boolean) => {
    const saved = preference()
    const ids = saved.mode === "custom" ? saved.modelIds : modelIds()
    save({
      mode: "custom",
      modelIds: checked ? [...ids, modelId] : ids.filter((id) => id !== modelId),
    })
  }

  return (
    <section class="provider-model-visibility" aria-labelledby={headingId}>
      <header class="provider-model-visibility-header">
        <button type="button" class="selector-button selector-button-secondary" onClick={props.onBack}>
          <ArrowLeft class="w-4 h-4" />
          {t("settings.providers.modelVisibility.back")}
        </button>
        <div>
          <h4 id={headingId} class="settings-card-title">
            {t("settings.providers.modelVisibility.title", { provider: props.providerName })}
          </h4>
          <p class="settings-card-subtitle">{t("settings.providers.modelVisibility.subtitle")}</p>
        </div>
      </header>

      <fieldset class="provider-model-visibility-modes">
        <legend class="sr-only">{t("settings.providers.modelVisibility.mode.label")}</legend>
        <label class="provider-model-visibility-mode">
          <input
            type="radio"
            name={`model-visibility-${props.providerId}`}
            checked={preference().mode === "all"}
            onChange={() => setMode("all")}
          />
          <span><strong>{t("settings.providers.modelVisibility.mode.all")}</strong><small>{t("settings.providers.modelVisibility.mode.all.description")}</small></span>
        </label>
        <label class="provider-model-visibility-mode">
          <input
            type="radio"
            name={`model-visibility-${props.providerId}`}
            checked={preference().mode === "custom"}
            onChange={() => setMode("custom")}
          />
          <span><strong>{t("settings.providers.modelVisibility.mode.custom")}</strong><small>{t("settings.providers.modelVisibility.mode.custom.description")}</small></span>
        </label>
      </fieldset>

      <div class="provider-model-visibility-toolbar">
        <label class="sr-only" for="provider-model-visibility-search">{t("settings.providers.modelVisibility.search.label")}</label>
        <input
          ref={searchInput}
          id="provider-model-visibility-search"
          type="search"
          class="providers-input"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("settings.providers.modelVisibility.search.placeholder")}
        />
        <span class="provider-model-visibility-count" role="status">
          {t("settings.providers.modelVisibility.count", { selected: selectedCurrentCount(), total: models().length })}
        </span>
        <button type="button" class="selector-button selector-button-secondary" disabled={preference().mode !== "custom"} onClick={selectAll}>
          {t("settings.providers.modelVisibility.selectAll")}
        </button>
        <button type="button" class="selector-button selector-button-secondary" disabled={preference().mode !== "custom"} onClick={() => save({ mode: "custom", modelIds: [] })}>
          {t("settings.providers.modelVisibility.selectNone")}
        </button>
      </div>

      <Show when={providerModelVisibilitySaveFailed(props.providerId)}>
        <p class="settings-error-message" role="alert">{t("settings.providers.modelVisibility.saveFailed")}</p>
      </Show>

      <Show when={unavailableCount() > 0}>
        <p class="provider-model-visibility-unavailable" role="status">
          {unavailableCount() === 1
            ? t("settings.providers.modelVisibility.unavailable.one", { count: unavailableCount() })
            : t("settings.providers.modelVisibility.unavailable.other", { count: unavailableCount() })}
        </p>
      </Show>

      <Show
        when={filteredModels().length > 0}
        fallback={<p class="settings-card-message" role="status">{t("settings.providers.modelVisibility.empty")}</p>}
      >
        <VList
          class="provider-model-visibility-list"
          data={filteredModels()}
          itemSize={54}
          role="list"
          aria-label={t("settings.providers.modelVisibility.listAriaLabel", { provider: props.providerName })}
        >
          {(model) => {
            const position = () => filteredModels().findIndex((item) => item.id === model.id) + 1
            return (
            <label
              class="provider-model-visibility-item"
              role="listitem"
              aria-posinset={position()}
              aria-setsize={filteredModels().length}
            >
              <input
                type="checkbox"
                checked={selectedIds().has(model.id)}
                disabled={preference().mode !== "custom"}
                onChange={(event) => toggleModel(model.id, event.currentTarget.checked)}
              />
              <span><strong>{model.name || model.id}</strong><small dir="ltr">{model.id}</small></span>
            </label>
            )
          }}
        </VList>
      </Show>
    </section>
  )
}
