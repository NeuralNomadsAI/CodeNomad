import { Show, createSignal, createUniqueId } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import { Plus } from "lucide-solid"
import type { PluginControlLocation, PluginControlScope } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { nativeSelectListOpen } from "../lib/native-select-open"
import { HttpResponseError } from "../lib/retryable-file-search"
import { pluginSourcesStore } from "../stores/plugin-sources"

const log = getLogger("session")

/** Header icon of the Plugins surface: a transient window that adds one registry or Git package
 * to a scope's OpenCode configuration. Success is shown by the row, never here. */
export function PluginSourceAdd(props: {
  instanceId: string
  location: PluginControlLocation
  projectAvailable: boolean
  active?: boolean
}) {
  const { t } = useI18n()
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [spec, setSpec] = createSignal("")
  const [scope, setScope] = createSignal<PluginControlScope>("global")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const scopeLabel = (value: PluginControlScope) => t(`instanceServiceStatus.plugins.scope.${value}`)

  const openChange = (next: boolean) => {
    if (pending()) return
    setOpen(next)
    if (next) { setSpec(""); setScope("global"); setError(undefined) }
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const value = spec().trim()
    if (!value || pending() || props.active === false) return
    // Never widen the chosen scope: an unavailable Project target is refused by the server.
    const target = scope()
    setPending(true)
    setError(undefined)
    try {
      await pluginSourcesStore.add(props.instanceId, props.location, target, value)
      setOpen(false)
    } catch (failure) {
      log.error("Failed to add plugin source", { scope: target, error: failure })
      setError(t(errorKey(failure), { scope: scopeLabel(target) }))
    } finally {
      setPending(false)
    }
  }

  return (
    <Popover placement="bottom-start" gutter={4} open={open()} onOpenChange={openChange}>
      <Popover.Trigger type="button" class="icon-button-compact" disabled={props.active === false}
        title={t("instanceServiceStatus.plugins.sources.add")} aria-label={t("instanceServiceStatus.plugins.sources.add")}>
        <Plus class="h-3.5 w-3.5" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="window-shell plugin-source-add" aria-busy={pending()}>
          <header class="window-header">
            <Popover.Title class="window-title">{t("instanceServiceStatus.plugins.sources.addTitle")}</Popover.Title>
          </header>
          <form onSubmit={event => void submit(event)}>
            <div class="window-body plugin-source-add-body">
              <label for={`${id}-spec`}>{t("instanceServiceStatus.plugins.sources.spec")}</label>
              <input id={`${id}-spec`} class="form-input" name="spec" autocomplete="off" autocapitalize="none" autocorrect="off"
                spellcheck={false} required maxLength={512} placeholder={t("instanceServiceStatus.plugins.sources.specPlaceholder")}
                value={spec()} disabled={pending()} aria-invalid={Boolean(error())} aria-describedby={`${id}-trust ${id}-error`}
                onInput={event => { setSpec(event.currentTarget.value); setError(undefined) }} />
              <label for={`${id}-scope`}>{t("instanceServiceStatus.plugins.sources.scope")}</label>
              <select id={`${id}-scope`} value={scope()} disabled={pending()}
                on:keydown={(event) => { if (event.key === "Escape" && nativeSelectListOpen(event.currentTarget)) event.stopPropagation() }}
                onChange={event => setScope(event.currentTarget.value as PluginControlScope)}>
                <option value="global">{scopeLabel("global")}</option>
                <option value="project" disabled={!props.projectAvailable}>{scopeLabel("project")}</option>
              </select>
              <Popover.Description id={`${id}-trust`} class="plugin-source-add-note">
                {t("instanceServiceStatus.plugins.sources.trust")}
              </Popover.Description>
              <Show when={scope() === "project"}>
                <p class="plugin-source-add-note" role="note">{t("instanceServiceStatus.plugins.sources.projectWarning")}</p>
              </Show>
              <p id={`${id}-error`} class="plugin-source-add-error" role="alert">{error() ?? ""}</p>
            </div>
            <div class="window-footer">
              <button type="submit" class="window-action" disabled={pending() || !spec().trim()} aria-busy={pending()}>
                {t(pending() ? "instanceServiceStatus.plugins.sources.adding" : "instanceServiceStatus.plugins.sources.submit")}
              </button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}

function errorKey(error: unknown): string {
  if (!(error instanceof HttpResponseError)) return "instanceServiceStatus.plugins.sources.errors.add"
  const known: Record<string, string> = {
    "invalid-spec": "instanceServiceStatus.plugins.sources.errors.invalidSpec",
    "local-path": "instanceServiceStatus.plugins.sources.errors.localPath",
    "plugin-id": "instanceServiceStatus.plugins.sources.errors.pluginId",
    duplicate: "instanceServiceStatus.plugins.sources.errors.duplicate",
    timeout: "instanceServiceStatus.plugins.sources.errors.timeout",
  }
  if (error.code && known[error.code]) return known[error.code]!
  if (error.status === 403) return "instanceServiceStatus.plugins.sources.errors.forbidden"
  if (error.status === 409) return "instanceServiceStatus.plugins.sources.errors.conflict"
  if (error.status === 422) return "instanceServiceStatus.plugins.sources.errors.invalidConfig"
  if (error.status === 503) return "instanceServiceStatus.plugins.sources.errors.unavailable"
  return "instanceServiceStatus.plugins.sources.errors.add"
}
