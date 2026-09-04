import { ArrowLeft } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onMount, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { useConfig } from "../../stores/preferences"

export interface ProviderVisibilityModel {
  id: string
  name: string
  providerId: string
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
  const hiddenIds = createMemo(() => new Set(models()
    .filter((model) => getProviderModelVisibilityPreference(model.providerId).hiddenModelIds.includes(model.id))
    .map((model) => `${model.providerId}\0${model.id}`)))
  const visibleCount = createMemo(() => models().filter((model) => !hiddenIds().has(`${model.providerId}\0${model.id}`)).length)
  const filteredModels = createMemo(() => {
    const value = query().trim().toLocaleLowerCase()
    if (!value) return models()
    return models().filter((model) =>
      model.name.toLocaleLowerCase().includes(value) || model.id.toLocaleLowerCase().includes(value),
    )
  })

  createEffect(on(() => props.providerId, () => setQuery("")))
  onMount(() => queueMicrotask(() => searchInput?.focus()))

  const toggleModel = (model: ProviderVisibilityModel, visible: boolean) => {
    const current = getProviderModelVisibilityPreference(model.providerId).hiddenModelIds
    void setProviderModelVisibility(model.providerId, {
      hiddenModelIds: visible ? current.filter((id) => id !== model.id) : [...current, model.id],
    }).catch(() => undefined)
  }

  const setAllVisible = (visible: boolean) => {
    const modelsByProvider = new Map<string, string[]>()
    for (const model of models()) modelsByProvider.set(model.providerId, [...(modelsByProvider.get(model.providerId) ?? []), model.id])
    for (const [providerId, ids] of modelsByProvider) {
      const current = getProviderModelVisibilityPreference(providerId).hiddenModelIds
      const hiddenModelIds = visible ? current.filter((id) => !ids.includes(id)) : Array.from(new Set([...current, ...ids]))
      void setProviderModelVisibility(providerId, { hiddenModelIds }).catch(() => undefined)
    }
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
        <button type="button" class="selector-button selector-button-secondary" onClick={() => setAllVisible(true)}>
          {t("settings.providers.modelVisibility.actions.showAll")}
        </button>
        <button type="button" class="selector-button selector-button-secondary" onClick={() => setAllVisible(false)}>
          {t("settings.providers.modelVisibility.actions.hideAll")}
        </button>
      </div>

      <Show when={models().some((model) => providerModelVisibilitySaveFailed(model.providerId))}>
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
                checked={!hiddenIds().has(`${model.providerId}\0${model.id}`)}
                onChange={(event) => toggleModel(model, event.currentTarget.checked)}
              />
              <span><strong>{model.name || model.id}</strong><small dir="ltr">{model.id}</small></span>
            </label>
          )}</For>
        </div>
      </Show>
    </section>
  )
}
