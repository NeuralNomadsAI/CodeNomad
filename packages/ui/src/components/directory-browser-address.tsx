import { Component, For, Show, createEffect, createSignal, createUniqueId } from "solid-js"
import { ArrowLeft, ArrowUpLeft, Folder, Home } from "lucide-solid"
import { useI18n } from "../lib/i18n"

export interface DirectoryDestination {
  target: string
  label: string
  kind: "initial" | "parent" | "home" | "folder"
}

interface DirectoryBrowserAddressProps {
  value: string
  destinations: DirectoryDestination[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onInput: (value: string) => void
  onReset: () => void
  onSubmit: () => void
  onChoose: (destination: DirectoryDestination) => void
}

const DirectoryBrowserAddress: Component<DirectoryBrowserAddressProps> = (props) => {
  const { t } = useI18n()
  const id = createUniqueId()
  const [active, setActive] = createSignal(-1)
  const isExpanded = () => props.open && props.destinations.length > 0

  createEffect(() => {
    if (isExpanded() && active() >= 0) {
      document.getElementById(`${id}-${active()}`)?.scrollIntoView({ block: "nearest" })
    }
  })

  return (
    <div class="directory-browser-address" onFocusOut={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onOpenChange(false)
    }}>
      <input
        type="text"
        value={props.value}
        onInput={(event) => { props.onInput(event.currentTarget.value); setActive(-1) }}
        onFocus={() => { props.onOpenChange(true); setActive(-1) }}
        onClick={() => { if (!props.open) { props.onOpenChange(true); setActive(-1) } }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && props.open) {
            event.preventDefault()
            event.stopPropagation()
            props.onOpenChange(false)
            props.onReset()
          } else if (event.key === "ArrowDown" && !props.open && props.destinations.length > 0) {
            event.preventDefault()
            props.onOpenChange(true)
            setActive(0)
          } else if (event.key === "ArrowDown" && isExpanded()) {
            event.preventDefault()
            setActive((index) => Math.min(index + 1, props.destinations.length - 1))
          } else if (event.key === "ArrowUp" && isExpanded()) {
            event.preventDefault()
            setActive((index) => Math.max(index - 1, -1))
          } else if (event.key === "Enter") {
            event.preventDefault()
            const destination = isExpanded() ? props.destinations[active()] : undefined
            if (destination) props.onChoose(destination)
            else props.onSubmit()
            props.onOpenChange(false)
            setActive(-1)
          }
        }}
        spellcheck={false}
        placeholder={t("directoryBrowser.currentFolder.inputPlaceholder")}
        aria-label={t("directoryBrowser.currentFolder.inputAriaLabel")}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isExpanded()}
        aria-controls={isExpanded() ? id : undefined}
        aria-activedescendant={isExpanded() && active() >= 0 ? `${id}-${active()}` : undefined}
        class="selector-input directory-browser-current-path"
      />
      <Show when={isExpanded()}>
        <div id={id} class="directory-browser-destinations" role="listbox" aria-label={t("directoryBrowser.goTo")}>
          <For each={props.destinations}>
            {(destination, index) => (
              <button
                type="button"
                role="option"
                id={`${id}-${index()}`}
                class="directory-browser-destination"
                data-active={active() === index() ? "" : undefined}
                aria-selected={active() === index()}
                title={destination.target}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { props.onChoose(destination); props.onOpenChange(false); setActive(-1) }}
              >
                {destination.kind === "initial" ? <ArrowLeft class="w-4 h-4" />
                  : destination.kind === "parent" ? <ArrowUpLeft class="w-4 h-4" />
                  : destination.kind === "home" ? <Home class="w-4 h-4" />
                  : <Folder class="w-4 h-4" />}
                <span class="truncate">{destination.label}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default DirectoryBrowserAddress
