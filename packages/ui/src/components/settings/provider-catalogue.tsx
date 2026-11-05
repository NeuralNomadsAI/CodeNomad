import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import type { PreferencesProjectContext } from "./preferences-project-context"
import { getRootClient } from "../../stores/opencode-client"
import { requestLocationOptions, toRequestLocation } from "../../stores/request-locations"
import { buildProviderCatalog, catalogModels, type CatalogModel } from "../../lib/model-catalog"
import { serverEvents } from "../../lib/server-events"
import { useI18n } from "../../lib/i18n"
import { createEventRefreshScheduler } from "../../lib/event-refresh-scheduler"

/** Explicit targets expose only qualified native catalogue metadata, never integrations/accounts. */
export function ProviderCatalogue(props: { context: PreferencesProjectContext; active: () => boolean }) {
  const { t } = useI18n()
  const [models, setModels] = createSignal<CatalogModel[]>([])
  const [failed, setFailed] = createSignal(false)
  createEffect(() => {
    const context = props.context, location = context.location!
    let alive = true, revision = 0
    const controller = new AbortController()
    const current = () => alive && props.active() && props.context === context
    const scheduler = createEventRefreshScheduler(async () => {
      if (!current()) return
      const epoch = ++revision
      try {
        const client = getRootClient(context.instanceId!), input = { location: toRequestLocation(location) }
        const options = { ...requestLocationOptions(location), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) }
        const [providers, listed] = await Promise.all([client.provider.list(input, options), client.model.list(input, options)])
        if (!current() || epoch !== revision) return
        setModels(catalogModels(buildProviderCatalog(providers.data, listed.data))); setFailed(false)
      } catch { if (current() && epoch === revision) setFailed(true) }
    })
    const refresh = () => { if (current()) scheduler.schedule("catalogue", "urgent") }
    const events = serverEvents.on("instance.event", event => {
      if (event.type === "instance.event" && event.instanceId === context.instanceId && ["model.updated", "config.updated"].includes(event.event.type)) refresh()
    })
    const reconnect = serverEvents.onOpen(refresh)
    onCleanup(() => { alive = false; controller.abort(); scheduler.cancel("catalogue"); events(); reconnect() })
    refresh()
  })
  return <section class="settings-card" aria-label={t("settings.providers.models.title")}>
    <p class="settings-card-message">{t("settings.execution.catalogueOnly")}</p>
    <Show when={failed()}><p role="status">{t("settings.providers.errors.loadFailed")}</p></Show>
    <ul><For each={models()}>{model => <li class="break-all"><bdi>{model.providerName} · {model.name}</bdi></li>}</For></ul>
  </section>
}
