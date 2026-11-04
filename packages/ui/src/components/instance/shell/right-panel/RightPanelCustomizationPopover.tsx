import { For, Show, createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { toggleSweepGroup } from "../../../../lib/toggle-sweep"
import { ExtensionManager } from "../../../panel-extensions/extension-manager"
import type { usePanelExtensions } from "../../../panel-extensions/use-panel-extensions"
import {
  moveRightPanelItem,
  parseRightPanelCustomization,
  setRightPanelItemHidden,
  type RightPanelCustomization,
  type RightPanelItem,
  type RightPanelTabModule,
} from "./registry"

type PanelExtensions = ReturnType<typeof usePanelExtensions>

interface RightPanelCustomizationPopoverProps {
  t: (key: string, vars?: Record<string, any>) => string
  isActive: Accessor<boolean>
  trigger: () => HTMLButtonElement | undefined
  onClose: () => void
  extensions: PanelExtensions
  tabs: Accessor<readonly RightPanelTabModule[]>
  statusSections: Accessor<readonly RightPanelItem[]>
  visibleStatusSectionCount: Accessor<number>
  customization: Accessor<RightPanelCustomization>
  onCustomizationChange: (updater: (current: RightPanelCustomization) => RightPanelCustomization) => void
}

/** Visibility and order of the right panel's tabs and Status sections. Up/Down reorders the focused Status section. */
export function RightPanelCustomizationPopover(props: RightPanelCustomizationPopoverProps) {
  let popover: HTMLDivElement | undefined
  const [extensionsExpanded, setExtensionsExpanded] = createSignal(false)
  const extensionForTab = (id: string) => props.extensions.entries().find(entry => id === `extension:${entry.manifest.id}`)

  createEffect(() => {
    const fitPopover = () => {
      if (popover) popover.style.maxHeight = `${Math.max(0, window.innerHeight - popover.getBoundingClientRect().top - 8)}px`
    }
    queueMicrotask(() => { fitPopover(); popover?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)")?.focus() })
    window.addEventListener("resize", fitPopover)
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!props.trigger()?.contains(target) && !popover?.contains(target)) props.onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      props.onClose()
      queueMicrotask(() => props.trigger()?.focus())
    }
    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", closeOnEscape)
    onCleanup(() => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape)
      window.removeEventListener("resize", fitPopover)
    })
  })

  const moveSection = (event: KeyboardEvent, id: string) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    const displayed = props.statusSections().map((section) => section.id)
    props.onCustomizationChange((current) => ({
      ...current,
      statusSectionOrder: moveRightPanelItem(current.statusSectionOrder, displayed, id, event.key === "ArrowUp" ? -1 : 1),
    }))
    // Reordering moves the row's node, which drops its focus.
    queueMicrotask(() => popover?.querySelector<HTMLInputElement>(`input[data-status-section-toggle="${CSS.escape(id)}"]`)?.focus())
  }

  return (
    <div ref={popover} class="right-panel-customization-popover" role="group" aria-label={props.t("instanceShell.rightPanel.customize.title")}>
      <div class="right-panel-customization-grid">
        <For each={props.tabs()}>
          {(tab) => {
            const label = () => tab.label ?? props.t(tab.labelKey)
            const extension = () => extensionForTab(tab.id)
            const visible = () => extension()?.enabled ?? (tab.alwaysVisible || !props.customization().hiddenTabIds.includes(tab.id))
            return (
              <>
                <div class="right-panel-customization-row">
                  <label class="right-panel-customization-label">
                    <input
                      type="checkbox"
                      checked={visible()}
                      disabled={tab.alwaysVisible || (Boolean(extension()) && (!props.extensions.verified() || props.extensions.activating() || !props.isActive()))}
                      // Activating an extension is a trust decision, never swept along.
                      data-toggle-sweep={extension() ? undefined : toggleSweepGroup("right-panel-customization")}
                      onChange={(event) => {
                        const entry = extension()
                        if (entry) {
                          const enabled = event.currentTarget.checked
                          event.currentTarget.checked = entry.enabled
                          void props.extensions.activate(entry, enabled)
                          return
                        }
                        props.onCustomizationChange((current) => ({
                          ...current,
                          hiddenTabIds: setRightPanelItemHidden(current.hiddenTabIds, tab.id, !event.currentTarget.checked),
                        }))
                      }}
                    />
                    <span>{label()}</span>
                  </label>
                </div>
                <Show when={tab.id === "status"}>
                  <For each={props.statusSections()}>
                    {(section) => {
                      const sectionLabel = () => section.label ?? props.t(section.labelKey)
                      const sectionVisible = () => !props.customization().hiddenStatusSectionIds.includes(section.id)
                      const disableHide = () => sectionVisible() && props.visibleStatusSectionCount() <= 1
                      return (
                        <div class="right-panel-customization-row right-panel-customization-row-indent">
                          <label class="right-panel-customization-label">
                            <input
                              type="checkbox"
                              checked={sectionVisible()}
                              // Stays focusable, so the last shown section can still be reordered.
                              aria-disabled={disableHide()}
                              data-status-section-toggle={section.id}
                              aria-keyshortcuts="ArrowUp ArrowDown"
                              data-toggle-sweep={disableHide() ? undefined : toggleSweepGroup("right-panel-customization")}
                              onKeyDown={(event) => moveSection(event, section.id)}
                              onClick={(event) => { if (disableHide()) event.preventDefault() }}
                              onChange={(event) =>
                                props.onCustomizationChange((current) => ({
                                  ...current,
                                  hiddenStatusSectionIds: setRightPanelItemHidden(
                                    current.hiddenStatusSectionIds,
                                    section.id,
                                    !event.currentTarget.checked,
                                  ),
                                }))
                              }
                            />
                            <span>{sectionLabel()}</span>
                          </label>
                        </div>
                      )
                    }}
                  </For>
                </Show>
              </>
            )
          }}
        </For>
      </div>
      <Show when={props.extensions.failed()}><p role="alert">{props.t("panelExtensions.error")}</p></Show>
      <button
        type="button"
        class="right-panel-customization-button mt-2 w-full"
        onClick={() => props.onCustomizationChange(() => parseRightPanelCustomization(null))}
      >
        {props.t("instanceShell.rightPanel.customize.reset")}
      </button>
      <hr class="panel-extension-divider" />
      <details class="panel-extension-disclosure" onToggle={event => setExtensionsExpanded(event.currentTarget.open)}>
        <summary>{props.t("panelExtensions.section")}</summary>
        <Show when={extensionsExpanded()}><ExtensionManager controller={props.extensions} /></Show>
      </details>
    </div>
  )
}
