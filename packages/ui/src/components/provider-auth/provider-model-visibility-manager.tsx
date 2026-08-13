import { ArrowLeft } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onMount, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
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
  const headingId = "provider-model-visibility-heading"
  let searchInput: HTMLInputElement | undefined

  const models = createMemo(() => [...props.models].sort(compareModel))
  const modelIds = createMemo(() => models().map((model) => model.id))
  const preference = createMemo(() => getProviderModelVisibilityPreference(props.providerId))
  const hiddenIds = createMemo(() => new Set(preference().hiddenModelIds))
  const visibleCount = createMemo(() => modelIds().filter((id) => !hiddenIds().has(id)).length)
  const filteredModels = createMemo(() => {
    const value = query().trim().toLocaleLowerCase()
    if (!value) return models()
    return models().filter((model) =>
      model.name.toLocaleLowerCase().includes(value) || model.id.toLocaleLowerCase().includes(value),
    )
  })

  createEffect(on(() => props.providerId, () => setQuery("")))
  onMount(() => queueMicrotask(() => searchInput?.focus()))

  const save = (hiddenModelIds: readonly string[]) =>
    void setProviderModelVisibility(props.providerId, { hiddenModelIds }).catch(() => undefined)

  const toggleModel = (modelId: string, visible: boolean) => {
    const current = preference().hiddenModelIds
    save(visible ? current.filter((id) => id !== modelId) : [...current, modelId])
  }

  const hideAll = () => save([...preference().hiddenModelIds, ...modelIds()])

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
          {t("settings.providers.modelVisibility.count.visible", { visible: visibleCount(), total: models().length })}
        </span>
        <button type="button" class="selector-button selector-button-secondary" onClick={() => save([])}>
          {t("settings.providers.modelVisibility.actions.showAll")}
        </button>
        <button type="button" class="selector-button selector-button-secondary" onClick={hideAll}>
          {t("settings.providers.modelVisibility.actions.hideAll")}
        </button>
      </div>

      <Show when={providerModelVisibilitySaveFailed(props.providerId)}>
        <p class="settings-error-message" role="alert">{t("settings.providers.modelVisibility.save.failed")}</p>
      </Show>

      <Show
        when={filteredModels().length > 0}
        fallback={<p class="settings-card-message" role="status">{t("settings.providers.modelVisibility.list.empty")}</p>}
      >
        <div
          class="provider-model-visibility-list"
          role="list"
          aria-label={t("settings.providers.modelVisibility.list.label", { provider: props.providerName })}
        >
          <For each={filteredModels()}>{(model) => (
            <label class="provider-model-visibility-item" role="listitem">
              <input
                type="checkbox"
                checked={!hiddenIds().has(model.id)}
                onChange={(event) => toggleModel(model.id, event.currentTarget.checked)}
              />
              <span><strong>{model.name || model.id}</strong><small dir="ltr">{model.id}</small></span>
            </label>
          )}</For>
        </div>
      </Show>
    </section>
  )
}
