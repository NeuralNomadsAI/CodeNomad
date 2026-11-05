// prototype-1236 (R27–R30): the Remotes disclosure shared by the home page and the new-instance launcher.
import { ContextMenu } from "@kobalte/core/context-menu"
import { For, Show, createSignal } from "solid-js"
import { ArrowLeft, ArrowUpLeft, ChevronRight, Folder, Loader2, Plus, Server, Trash2 } from "lucide-solid"
import type { FileSystemListResponse } from "../../../server/src/api-types"
import { WINDOWS_DRIVES_ROOT } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { isOpenCodeServerAddress } from "../lib/opencode-pairing-link"
import { useRemoteServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import { showConfirmDialog } from "../stores/alerts"
import { closeInstanceTab } from "../stores/app-tabs"
import { instances } from "../stores/instances"
import { getExplicitOpenCodeServers, getLaunchableRecentFolders } from "../stores/preferences"

type RemoteServer = { id: string; label: string }

interface RemoteProjectMenuProps {
  isLoading: boolean
  /** Adding and removing servers is reserved to the host window. */
  canManage: boolean
  onOpenFolder: (path: string, serverId: string) => void
}

const NAV = "[data-remote-nav]"

/**
 * Lists explicit OpenCode servers inline; a server shows its folders in place
 * (Backspace: parent folder, Escape: server list, then collapse).
 */
export default function RemoteProjectMenu(props: RemoteProjectMenuProps) {
  const { t } = useI18n()
  const { saveServer } = useRemoteServerProfiles()
  const [expanded, setExpanded] = createSignal(false)
  const [server, setServer] = createSignal<RemoteServer>()
  const [listing, setListing] = createSignal<FileSystemListResponse>()
  const [listError, setListError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [address, setAddress] = createSignal("")
  const [addError, setAddError] = createSignal<string>()
  // A just-added server shows before the next configuration snapshot lists it.
  const [added, setAdded] = createSignal<RemoteServer[]>([])
  let toggleRef: HTMLButtonElement | undefined
  let bodyRef: HTMLDivElement | undefined
  let generation = 0

  const servers = () => {
    const known = getExplicitOpenCodeServers()
    return [...known, ...added().filter((entry) => !known.some((item) => item.id === entry.id))]
  }
  const visible = () => props.canManage || servers().length > 0

  const navItems = () => [...(bodyRef?.querySelectorAll<HTMLElement>(NAV) ?? [])].filter((item) => !item.hasAttribute("disabled"))
  function focusNav(selector?: string) {
    queueMicrotask(() => {
      const target = (selector ? bodyRef?.querySelector<HTMLElement>(selector) : undefined) ?? navItems()[0]
      target?.focus()
    })
  }

  async function list(target: RemoteServer, path: string | undefined, focusName?: string) {
    const current = ++generation
    setBusy(true)
    setListError(undefined)
    try {
      const response = await serverApi.listOpenCodeFolders(target.id, path)
      if (current !== generation) return
      setListing(response)
      focusNav(focusName ? `[data-remote-folder="${CSS.escape(focusName)}"]` : "[data-remote-folder]")
    } catch (error) {
      if (current !== generation) return
      setListError(error instanceof Error && error.message ? error.message : t("directoryBrowser.load.errorFallback"))
      focusNav()
    } finally {
      if (current === generation) setBusy(false)
    }
  }

  function openServer(target: RemoteServer) {
    setServer(target)
    setListing(undefined)
    focusNav("[data-remote-back]")
    void list(target, getLaunchableRecentFolders().find((folder) => folder.serverId === target.id)?.path)
  }

  function showServers() {
    const previous = server()
    generation++
    setServer(undefined)
    setListing(undefined)
    setListError(undefined)
    setBusy(false)
    focusNav(previous ? `[data-remote-server="${CSS.escape(previous.id)}"]` : undefined)
  }

  function goUp() {
    const target = server()
    const metadata = listing()?.metadata
    if (!target || !metadata?.parentPath) return showServers()
    void list(target, metadata.parentPath, metadata.currentPath)
  }

  function collapse() {
    showServers()
    setExpanded(false)
    toggleRef?.focus()
  }

  async function add(text: string) {
    const value = text.trim()
    if (!value || busy()) return
    setAddError(undefined)
    if (!isOpenCodeServerAddress(value)) return setAddError(t("folderSelection.servers.dialog.errorConnect"))
    setBusy(true)
    try {
      const result = await saveServer({ name: "", baseUrl: value, skipTlsVerify: false }, false) as unknown as RemoteServer
      setAddress("")
      setAdded((entries) => [...entries.filter((entry) => entry.id !== result.id), { id: result.id, label: result.label }])
      setBusy(false)
      openServer({ id: result.id, label: result.label })
    } catch (error) {
      setAddError(error instanceof Error ? error.message : t("folderSelection.servers.dialog.errorConnect"))
      setBusy(false)
    }
  }

  async function remove(target: RemoteServer) {
    const confirmed = await showConfirmDialog(t("folderSelection.servers.opencode.removeConfirm", { name: target.label }), {
      title: t("folderSelection.servers.remove"),
      variant: "warning",
      confirmLabel: t("folderSelection.servers.remove"),
    })
    if (!confirmed) return
    // Close what is known here; the backend disconnects every other attachment.
    for (const instance of instances().values()) if (instance.binding?.serverId === target.id) closeInstanceTab(instance.id)
    setAdded((entries) => entries.filter((entry) => entry.id !== target.id))
    try {
      await serverApi.removeOpenCodeServer(target.id)
    } catch (error) {
      setAddError(error instanceof Error ? error.message : t("folderSelection.servers.dialog.errorConnect"))
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return
    const items = navItems()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const inField = (event.target as HTMLElement).tagName === "INPUT"
    const move = (next: number) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus() }
    if (event.key === "ArrowDown") move(index + 1)
    else if (event.key === "ArrowUp") move(index - 1)
    else if (event.key === "Home" && !inField) move(0)
    else if (event.key === "End" && !inField) move(items.length - 1)
    else if (event.key === "Escape") { event.preventDefault(); server() ? showServers() : collapse() }
    else if (server() && (event.key === "Backspace" || event.key === "ArrowLeft")) { event.preventDefault(); goUp() }
    else if (event.key === "ArrowRight" && !inField) {
      const data = (document.activeElement as HTMLElement | null)?.dataset
      const current = server()
      const target = servers().find((entry) => entry.id === data?.remoteServer)
      if (current && data?.remoteFolder) { event.preventDefault(); void list(current, data.remoteFolder) }
      else if (!current && target) { event.preventDefault(); openServer(target) }
    }
  }

  const canOpen = () => {
    const metadata = listing()?.metadata
    return Boolean(metadata && metadata.currentPath !== WINDOWS_DRIVES_ROOT && !busy() && !props.isLoading)
  }

  return (
    <Show when={visible()}>
      <button type="button" class="remote-project-toggle" ref={toggleRef} aria-expanded={expanded()} disabled={props.isLoading}
        onClick={() => { if (expanded()) return collapse(); setExpanded(true); focusNav() }}
        onKeyDown={(event) => { if (event.key === "ArrowDown" && expanded()) { event.preventDefault(); focusNav() } }}>
        <ChevronRight class="disclosure-chevron w-3.5 h-3.5" aria-hidden="true" />
        <span>{t("folderSelection.remoteProject.title")}</span>
      </button>
      <Show when={expanded()}>
        <div class="remote-project-menu" ref={bodyRef} role="group" aria-label={t("folderSelection.remoteProject.title")}
          aria-busy={busy()} onKeyDown={handleKeyDown}>
          <Show when={server()} fallback={
            <>
              <For each={servers()}>
                {(entry) => {
                  const row = {
                    type: "button" as const, class: "remote-project-row", "data-remote-nav": "", "data-remote-server": entry.id,
                    disabled: props.isLoading, onClick: () => openServer(entry),
                    "aria-label": t("folderSelection.remoteProject.openProject", { name: entry.label }),
                  }
                  const content = () => <>
                    <Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                    <bdi class="remote-project-name" dir="auto" title={entry.label}>{entry.label}</bdi>
                    <span class="window-action shrink-0" aria-hidden="true">
                      <Plus class="w-3.5 h-3.5" />
                      <span>{t("folderSelection.remoteProject.project")}</span>
                    </span>
                  </>
                  // Removal lives in the row's context menu (right-click, Shift+F10, Menu key).
                  return (
                    <Show when={props.canManage} fallback={<button {...row}>{content()}</button>}>
                      <ContextMenu>
                        <ContextMenu.Trigger as="button" {...row}>{content()}</ContextMenu.Trigger>
                        <ContextMenu.Portal>
                          <ContextMenu.Content class="action-overflow-content">
                            <ContextMenu.Item class="action-overflow-item" onSelect={() => void remove(entry)}>
                              <span class="action-overflow-item-icon" aria-hidden="true"><Trash2 class="w-3.5 h-3.5" /></span>
                              <span class="action-overflow-item-label">{t("folderSelection.servers.remove")}</span>
                            </ContextMenu.Item>
                          </ContextMenu.Content>
                        </ContextMenu.Portal>
                      </ContextMenu>
                    </Show>
                  )
                }}
              </For>
              <Show when={props.canManage}>
                <form class="remote-project-add" onSubmit={(event) => { event.preventDefault(); void add(address()) }}>
                  <input type="text" class="remote-project-add-input" data-remote-nav autocomplete="off" spellcheck={false}
                    aria-label={t("folderSelection.remoteProject.add")}
                    placeholder={t("folderSelection.remoteProject.addPlaceholder")}
                    value={address()} disabled={busy()}
                    onInput={(event) => { setAddress(event.currentTarget.value); setAddError(undefined) }}
                    onPaste={(event) => {
                      const text = event.clipboardData?.getData("text") ?? ""
                      if (!isOpenCodeServerAddress(text)) return
                      event.preventDefault()
                      void add(text)
                    }} />
                  <button type="submit" class="window-icon-button" disabled={busy() || !address().trim()}
                    aria-label={t("folderSelection.remoteProject.add")} title={t("folderSelection.remoteProject.add")}>
                    <Show when={busy()} fallback={<Plus class="w-4 h-4" aria-hidden="true" />}>
                      <Loader2 class="w-4 h-4 animate-spin" aria-hidden="true" />
                    </Show>
                  </button>
                </form>
              </Show>
              <Show when={addError()}>{(message) => <p class="remote-project-error" role="alert">{message()}</p>}</Show>
            </>
          }>
            {(current) => (
              <>
                <div class="remote-project-header">
                  <button type="button" class="window-icon-button" data-remote-nav data-remote-back onClick={showServers}
                    aria-label={t("folderSelection.remoteProject.back")} title={t("folderSelection.remoteProject.back")}>
                    <ArrowLeft class="w-4 h-4" aria-hidden="true" />
                  </button>
                   <bdi class="remote-project-name" dir="auto" title={current().label}>{current().label}</bdi>
                  <span class="remote-project-path truncate-start" title={listing()?.metadata.displayPath}>{listing()?.metadata.displayPath}</span>
                  <button type="button" class="window-action" data-remote-nav disabled={!canOpen()}
                    onClick={() => props.onOpenFolder(listing()!.metadata.currentPath, current().id)}>
                    {t("directoryBrowser.openCurrent")}
                  </button>
                </div>
                <div class="remote-project-folders">
                  <Show when={listing()?.metadata.parentPath}>
                    <button type="button" class="remote-project-row" data-remote-nav disabled={busy()} onClick={goUp}>
                      <ArrowUpLeft class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                      <span class="remote-project-name">{t("directoryBrowser.goToParent")}</span>
                    </button>
                  </Show>
                  <For each={listing()?.entries.filter((entry) => entry.type === "directory") ?? []}>
                    {(entry) => {
                      const path = entry.absolutePath ?? entry.path
                      return (
                        <button type="button" class="remote-project-row" data-remote-nav data-remote-folder={path} disabled={busy()}
                          title={path} onClick={() => void list(current(), path)}>
                          <Folder class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                          <span class="remote-project-name">{entry.name}</span>
                        </button>
                      )
                    }}
                  </For>
                  <Show when={listError()} fallback={
                    <Show when={busy() || listing()?.entries.length === 0}>
                      <p class="remote-project-empty">{t(busy() ? "directoryBrowser.loadingFolders" : "directoryBrowser.noFolders")}</p>
                    </Show>
                  }>
                    {(message) => <p class="remote-project-error" role="alert">{message()}</p>}
                  </Show>
                </div>
              </>
            )}
          </Show>
        </div>
      </Show>
    </Show>
  )
}
