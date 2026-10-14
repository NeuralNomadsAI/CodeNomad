import { createMemo, createSignal, For, onCleanup, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getHotkeyDefinitions, type HotkeyDefinition } from "../../lib/hotkey-definitions"
import { findHotkeyConflicts, hotkeyEventKey, type HotkeyBinding } from "../../lib/hotkey-bindings"
import { hotkeyLabel, resetHotkeyOverrides, saveHotkeyOverride, setHotkeyRecording } from "../../lib/hotkeys"
import { useConfig } from "../../stores/preferences"

export const HotkeysSettingsSection: Component = () => {
  const { t } = useI18n()
  const { preferences } = useConfig()
  const [filter, setFilter] = createSignal("")
  const [recording, setRecording] = createSignal<string>()
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal(false)
  const mac = navigator.platform.toLowerCase().includes("mac")
  const definitions = getHotkeyDefinitions()
  const actionLabel = (definition: HotkeyDefinition) => t(definition.labelKey, { index: definition.id.match(/-(\d)$/)?.[1] })
  const rows = createMemo(() => {
    const query = filter().trim().toLocaleLowerCase()
    return definitions.filter(definition => `${actionLabel(definition)} ${hotkeyLabel(definition.id)}`.toLocaleLowerCase().includes(query))
  })
  const conflicts = createMemo(() => findHotkeyConflicts(preferences().hotkeyOverrides, preferences().promptSubmitOnEnter, mac))
  const warning = (id: string) => conflicts().filter(conflict => conflict.ids.includes(id)).map(conflict => {
    const actions = conflict.ids.filter(other => other !== id).map(other => {
      const definition = definitions.find(item => item.id === other)
      return definition ? actionLabel(definition) : other
    }).join(", ")
    return t("hotkeys.conflict", { shortcut: conflict.binding, actions })
  }).join(" · ")

  function stopRecording() {
    setRecording(undefined)
    setHotkeyRecording(false)
  }
  onCleanup(stopRecording)
  window.addEventListener("blur", stopRecording)
  onCleanup(() => window.removeEventListener("blur", stopRecording))

  function beginRecording(id: string) {
    stopRecording()
    setHotkeyRecording(true)
    setRecording(id)
  }

  async function mutate(action: () => Promise<boolean>) {
    stopRecording()
    setError(false)
    setPending(true)
    try { setError(!(await action())) }
    catch { setError(true) }
    finally { setPending(false) }
  }

  function capture(id: string, event: KeyboardEvent) {
    if (recording() !== id || event.isComposing || event.keyCode === 229) return
    // Plain Tab/Shift+Tab navigate focus; modified Tab is a recordable combo.
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) return
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat || ["Dead", "Unidentified", "Process", "Shift", "Control", "Meta", "Alt", "AltGraph", "CapsLock"].includes(event.key)) return
    const primary = mac ? event.metaKey : event.ctrlKey
    const binding: HotkeyBinding = {
      key: hotkeyEventKey(event),
      ...(primary ? { mod: true } : {}),
      ...(mac && event.ctrlKey ? { ctrl: true } : {}),
      ...(!mac && event.metaKey ? { meta: true } : {}),
      ...(event.shiftKey ? { shift: true } : {}),
      ...(event.altKey ? { alt: true } : {}),
    }
    void mutate(() => saveHotkeyOverride(id, [binding]))
  }

  return <section class="settings-section-stack hotkeys-settings" aria-label={t("settings.nav.hotkeys")}>
    <div class="window-toolbar hotkeys-toolbar">
      <input class="hotkeys-filter" type="search" aria-label={t("hotkeys.filter")} placeholder={t("hotkeys.filter")}
        value={filter()} onInput={event => { stopRecording(); setFilter(event.currentTarget.value) }} />
      <button class="window-text-button" type="button" disabled={pending()} onClick={() => void mutate(resetHotkeyOverrides)}>{t("hotkeys.resetAll")}</button>
    </div>
    <Show when={error()}><p class="hotkeys-warning" role="alert">{t("hotkeys.saveFailed")}</p></Show>
    <div class="hotkeys-list">
      <For each={rows()}>{definition => <div class="hotkeys-row" data-hotkey-id={definition.id} role="group" aria-label={actionLabel(definition)}>
        <div class="hotkeys-action">
          <span>{actionLabel(definition)}</span>
          <Show when={warning(definition.id)}>{text => <p class="hotkeys-warning" role="status">{text()}</p>}</Show>
        </div>
        <Show when={recording() === definition.id} fallback={<kbd class="hotkeys-binding">{hotkeyLabel(definition.id) || t("hotkeys.disabled")}</kbd>}>
          <input class="hotkeys-capture" readonly value="" placeholder={t("hotkeys.capture")}
            aria-label={t("hotkeys.captureFor", { action: actionLabel(definition) })}
            ref={element => queueMicrotask(() => element.isConnected && element.focus())}
            onKeyDown={event => capture(definition.id, event)} onBlur={stopRecording} />
        </Show>
        <div class="window-actions hotkeys-actions">
          <Show when={recording() === definition.id} fallback={<button class="window-text-button" type="button" disabled={pending()}
            onClick={() => beginRecording(definition.id)}>{t("hotkeys.edit")}</button>}>
            <button class="window-text-button" type="button" onClick={stopRecording}>{t("hotkeys.cancel")}</button>
          </Show>
          <button class="window-text-button" type="button" disabled={pending()} onClick={() => void mutate(() => saveHotkeyOverride(definition.id, []))}>{t("hotkeys.disable")}</button>
          <button class="window-text-button" type="button" disabled={pending() || !Object.prototype.hasOwnProperty.call(preferences().hotkeyOverrides, definition.id)}
            onClick={() => void mutate(() => saveHotkeyOverride(definition.id))}>{t("hotkeys.reset")}</button>
        </div>
      </div>}</For>
      <Show when={!rows().length}><p>{t("hotkeys.noResults")}</p></Show>
    </div>
  </section>
}
