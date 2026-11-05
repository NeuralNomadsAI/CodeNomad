import { ContextMenu } from "@kobalte/core/context-menu"
import { For, Show, createSignal } from "solid-js"
import { ChevronRight, Loader2, Pencil, Plus, Server, Trash2 } from "lucide-solid"
import type { RemoteServerProfile } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { classifyCodeNomadLink, codeNomadLinkName, serverDisplayName } from "../lib/codenomad-link"
import { RemoteServerProbeError, useRemoteServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { showConfirmDialog } from "../stores/alerts"
import { opensRemoteProjectTab } from "../stores/remote-project-open"
import { openRemoteServerEditor } from "../stores/remote-server-editor"

interface RemoteProjectMenuProps {
  isLoading: boolean
  /** Called once a server opened, e.g. to dismiss the launcher. */
  onOpened?: () => void
}

/**
 * Remotes: the saved CodeNomad servers. A server opens a project tab whose view
 * picks the folder; a pasted pairing link or address adds one. Only host windows
 * (never a web client, a Remote Control device or a remote page) list or manage them.
 */
export default function RemoteProjectMenu(props: RemoteProjectMenuProps) {
  const { t } = useI18n()
  const { remoteServers, saveProfile, saveServer, openServer, removeRemoteServerProfile } = useRemoteServerProfiles()
  const [expanded, setExpanded] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [address, setAddress] = createSignal("")
  const [addError, setAddError] = createSignal<string>()
  let toggleRef: HTMLButtonElement | undefined
  let bodyRef: HTMLDivElement | undefined

  const navItems = () => [...(bodyRef?.querySelectorAll<HTMLElement>("[data-remote-nav]") ?? [])].filter((item) => !item.hasAttribute("disabled"))
  const focusFirst = () => queueMicrotask(() => navItems()[0]?.focus())
  const displayName = (profile: RemoteServerProfile) => serverDisplayName(profile, remoteServers())

  function open(profile: RemoteServerProfile, entryUrl?: string) {
    openServer(profile, entryUrl)
    props.onOpened?.()
  }

  function edit(request: Parameters<typeof openRemoteServerEditor>[0]) {
    // The launcher closes first; the dialog lives outside it.
    props.onOpened?.()
    openRemoteServerEditor(request)
  }

  async function add(text: string) {
    const value = text.trim()
    if (!value || busy()) return
    setAddError(undefined)
    const link = classifyCodeNomadLink(value)
    if (!link) return setAddError(t("folderSelection.servers.dialog.errorConnect"))
    const existing = remoteServers().find((server) => server.baseUrl === link.baseUrl)
    const input = {
      id: existing?.id, name: existing?.name ?? codeNomadLinkName(link.baseUrl), baseUrl: value,
      skipTlsVerify: existing?.skipTlsVerify ?? false,
    }
    setBusy(true)
    try {
      if (opensRemoteProjectTab(input)) {
        const { profile, entryUrl } = await saveProfile(input)
        open(profile, entryUrl)
      } else {
        // Without tabs, a pairing link still pairs in the server's own window.
        await saveServer(input, link.kind === "pairing")
        props.onOpened?.()
      }
      setAddress("")
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : t("folderSelection.servers.dialog.errorConnect")
      // A certificate that failed the check needs an explicit choice: the server dialog offers it.
      if (error instanceof RemoteServerProbeError && error.code === "tls_error" && link.kind === "address") {
        setAddress("")
        edit({ initial: input, initialError: message })
      } else {
        setAddError(message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function remove(profile: RemoteServerProfile) {
    const confirmed = await showConfirmDialog(t("folderSelection.remoteProject.removeConfirm", { name: displayName(profile) }), {
      title: t("folderSelection.servers.remove"),
      variant: "warning",
      confirmLabel: t("folderSelection.servers.remove"),
    })
    if (!confirmed) return
    removeRemoteServerProfile(profile.id)
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return
    const items = navItems()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const move = (next: number) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus() }
    if (event.key === "ArrowDown") move(index + 1)
    else if (event.key === "ArrowUp") move(index - 1)
    else if (event.key === "Escape") {
      event.preventDefault()
      setExpanded(false)
      toggleRef?.focus()
    }
  }

  return (
    <Show when={canOpenRemoteWindows()}>
      <button type="button" class="remote-project-toggle" ref={toggleRef} aria-expanded={expanded()} disabled={props.isLoading}
        onClick={() => { setExpanded(!expanded()); if (expanded()) focusFirst() }}>
        <ChevronRight class="disclosure-chevron w-3.5 h-3.5" aria-hidden="true" />
        <span>{t("folderSelection.remoteProject.title")}</span>
      </button>
      <Show when={expanded()}>
        <div class="remote-project-menu" ref={bodyRef} role="group" aria-label={t("folderSelection.remoteProject.title")}
          aria-busy={busy()} onKeyDown={handleKeyDown}>
          <For each={remoteServers()}>
            {(profile) => (
              // Editing and removal live in the row's context menu (right-click, Shift+F10, Menu key).
              <ContextMenu>
                <ContextMenu.Trigger as="button" type="button" class="remote-project-row" data-remote-nav data-remote-server={profile.id}
                  disabled={props.isLoading || busy()} title={profile.baseUrl} onClick={() => open(profile)}
                  aria-label={t("folderSelection.remoteProject.openProject", { name: displayName(profile) })}>
                  <Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                  <bdi class="remote-project-name" dir="auto">{displayName(profile)}</bdi>
                  <span class="window-action shrink-0" aria-hidden="true">
                    <Plus class="w-3.5 h-3.5" />
                    <span>{t("folderSelection.remoteProject.project")}</span>
                  </span>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content class="action-overflow-content">
                    <ContextMenu.Item class="action-overflow-item"
                      onSelect={() => edit({ initial: { id: profile.id, name: displayName(profile), baseUrl: profile.baseUrl, skipTlsVerify: profile.skipTlsVerify } })}>
                      <span class="action-overflow-item-icon" aria-hidden="true"><Pencil class="w-3.5 h-3.5" /></span>
                      <span class="action-overflow-item-label">{t("folderSelection.remoteProject.edit")}</span>
                    </ContextMenu.Item>
                    <ContextMenu.Item class="action-overflow-item" onSelect={() => void remove(profile)}>
                      <span class="action-overflow-item-icon" aria-hidden="true"><Trash2 class="w-3.5 h-3.5" /></span>
                      <span class="action-overflow-item-label">{t("folderSelection.servers.remove")}</span>
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu>
            )}
          </For>
          <form class="remote-project-add" onSubmit={(event) => { event.preventDefault(); void add(address()) }}>
            <input type="text" class="remote-project-add-input" data-remote-nav autocomplete="off" spellcheck={false}
              aria-label={t("folderSelection.remoteProject.add")}
              placeholder={t("folderSelection.remoteProject.addPlaceholder")}
              value={address()} disabled={busy()}
              onInput={(event) => { setAddress(event.currentTarget.value); setAddError(undefined) }}
              onPaste={(event) => {
                const text = event.clipboardData?.getData("text") ?? ""
                if (!classifyCodeNomadLink(text)) return
                event.preventDefault()
                setAddress(text.trim())
                void add(text)
              }} />
            <button type="submit" class="window-icon-button" disabled={busy() || !address().trim()}
              aria-label={t("folderSelection.remoteProject.add")} title={t("folderSelection.remoteProject.add")}>
              <Show when={busy()} fallback={<Plus class="w-4 h-4" aria-hidden="true" />}>
                <Loader2 class="w-4 h-4 animate-spin" aria-hidden="true" />
              </Show>
            </button>
          </form>
          <Show when={addError()}>{(message) => <p class="remote-project-error" role="alert">{message()}</p>}</Show>
        </div>
      </Show>
    </Show>
  )
}
