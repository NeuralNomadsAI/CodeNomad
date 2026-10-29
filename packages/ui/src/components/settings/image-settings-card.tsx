import { For, Show } from "solid-js"
import type { LocationRef } from "@opencode/client"
import type { ImageGenerationSelection } from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"
import { SettingsInfoTip } from "./settings-info-tip"
import { SettingsChoiceRow } from "./settings-switch"
import { useImageSettings } from "./useImageSettings"

const encode = (value: ImageGenerationSelection) => value === false ? "off" : value === true ? "auto" : `model:${value}`
const decode = (value: string): ImageGenerationSelection => value === "off" ? false : value === "auto" ? true : value.slice(6)

/** Global OpenCode image settings, embedded in Settings → Providers' Images group. */
export function ImageSettingsCard(props: { instanceId: string; location?: LocationRef }) {
  const { t } = useI18n()
  const settings = useImageSettings(props)

  return <section class="image-settings" aria-labelledby="providers-images-heading">
    <Show when={settings.error()}><p role="alert">{t("settings.images.error")}</p></Show>
    <Show when={settings.snapshot()}>{data => <>
      <Show when={!data().generation && !data().mediaStorage}>
        <p class="settings-toggle-caption">{t("settings.images.unsupported")}</p>
      </Show>
      <Show when={data().generation}>{generation => {
        const label = (value: ImageGenerationSelection) => value === false ? t("settings.images.generation.off")
          : value === true ? t("settings.images.generation.auto")
            : generation().models.find(model => model.ref === value)?.name ?? value
        return <div class="image-settings-generation">
          <label class="settings-toggle-row settings-toggle-row-compact">
            <span class="settings-toggle-title">
              {t("settings.images.generation.title")}<SettingsInfoTip text={t("settings.images.generation.info")} />
            </span>
            <select class="selector-trigger" aria-label={t("settings.images.generation.title")} disabled={settings.busy()}
              value={encode(generation().global)} onChange={event => void settings.save({ generation: decode(event.currentTarget.value) })}>
              <option value="off" selected={generation().global === false}>{t("settings.images.generation.off")}</option>
              <option value="auto" selected={generation().global === true}>{t("settings.images.generation.auto")}</option>
              <For each={generation().models}>{model =>
                <option value={encode(model.ref)} selected={generation().global === model.ref}>{model.name}</option>}</For>
              <Show when={typeof generation().global === "string" && !generation().models.some(model => model.ref === generation().global)}>
                <option value={encode(generation().global)} selected>{String(generation().global)}</option>
              </Show>
            </select>
          </label>
          <Show when={generation().projectOverride}>{path =>
            <p class="settings-toggle-caption" title={path()}>
              {t("settings.images.generation.projectOverride", { value: label(generation().effective) })}
            </p>}</Show>
          <Show when={generation().effective !== false && !generation().models.length}>
            <p class="settings-toggle-caption">{t("settings.images.generation.noModels")}</p>
          </Show>
        </div>
      }}</Show>
      <Show when={data().mediaStorage}>{storage => <>
        <SettingsChoiceRow checked={storage().global} title={t("settings.images.storage.title")}
          info={t("settings.images.storage.info")} disabled={settings.busy()}
          onChange={checked => void settings.save({ mediaStorage: checked })} />
        <Show when={storage().projectOverride}>{path =>
          <p class="settings-toggle-caption" title={path()}>
            {t(storage().effective ? "settings.images.storage.projectOverride.on" : "settings.images.storage.projectOverride.off")}
          </p>}</Show>
      </>}</Show>
    </>}</Show>
  </section>
}
