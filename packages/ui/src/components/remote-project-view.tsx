import { Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { embeddedProjectUrl, readEmbeddedProjectReport } from "../lib/embed-mode"
import { localOverlayOpen } from "../lib/native/browser"
import { closeRemoteView, onRemoteViewUpdated, openRemoteView, updateRemoteView } from "../lib/native/remote-view"
import { getLogger } from "../lib/logger"
import { recordRemoteProjectRecent, remoteServers } from "../stores/preferences"
import { patchRemoteProjectTab, type RemoteProjectTabRecord } from "../stores/remote-project-tabs"

const log = getLogger("actions")

interface RemoteProjectViewProps {
  tab: RemoteProjectTabRecord
  /** The tab is the one on screen. */
  active: boolean
}

/**
 * Holds the place of the native view showing the remote page. The view opens the
 * first time its tab shows, follows this element's bounds and hides whenever the
 * tab is not shown or a local dialog or menu would lie under it.
 */
export const RemoteProjectView: Component<RemoteProjectViewProps> = (props) => {
  const { t } = useI18n()
  const [error, setError] = createSignal<string>()
  let element!: HTMLDivElement

  onMount(() => {
    const token = props.tab.token
    const profileId = props.tab.profileId
    let disposed = false
    let opened = false
    let pending = false
    let failed = false
    let lastBounds = ""
    let unlisten = () => {}

    const fail = (cause: unknown) => {
      failed = true
      pending = false
      log.warn("Remote project view failed", { profileId, cause })
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
    }

    const visibleRect = (): DOMRect | null => {
      if (!props.active || localOverlayOpen()) return null
      const rect = element.getBoundingClientRect()
      return rect.width >= 1 && rect.height >= 1 ? rect : null
    }

    const sync = () => {
      if (disposed || pending || failed) return
      const rect = visibleRect()
      const key = rect ? [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(",") : ""
      if (!opened) {
        if (!rect) return
        const profile = remoteServers().find((entry) => entry.id === profileId)
        if (!profile) return fail(new Error(t("folderSelection.remoteProject.serverMissing")))
        pending = true
        const origin = new URL(profile.baseUrl).origin
        void onRemoteViewUpdated((update) => {
          if (update.viewId !== token) return
          const report = readEmbeddedProjectReport(update.url, update.title, origin)
          if (!report) return
          patchRemoteProjectTab(token, report)
          recordRemoteProjectRecent({ profileId, folder: report.folder, projectName: report.title })
        }).then(async (stop) => {
          if (disposed) return stop()
          unlisten = stop
          await openRemoteView({
            viewId: token,
            profileId,
            baseUrl: profile.baseUrl,
            url: props.tab.entryUrl ?? embeddedProjectUrl(profile.baseUrl, props.tab.folder),
          }, rect)
          opened = true
          lastBounds = key
          pending = false
          // A pairing code is single-use: a later reopen loads the project entry.
          patchRemoteProjectTab(token, { entryUrl: undefined })
          if (disposed) void closeRemoteView(token).catch(() => {})
          else sync()
        }).catch(fail)
        return
      }
      if (key === lastBounds) return
      lastBounds = key
      pending = true
      void updateRemoteView(token, rect).then(() => {
        pending = false
        sync()
      }).catch(fail)
    }

    const resizeObserver = new ResizeObserver(sync)
    const overlayObserver = new MutationObserver(sync)
    resizeObserver.observe(element)
    overlayObserver.observe(document.body, { attributes: true, childList: true, subtree: true })
    window.addEventListener("resize", sync)
    createEffect(() => {
      void props.active
      sync()
    })
    queueMicrotask(sync)

    onCleanup(() => {
      disposed = true
      resizeObserver.disconnect()
      overlayObserver.disconnect()
      window.removeEventListener("resize", sync)
      unlisten()
      if (opened) void closeRemoteView(token).catch((cause) => log.warn("Failed to close remote project view", { cause }))
    })
  })

  return (
    <div ref={element} class="flex-1 min-h-0 min-w-0 flex items-center justify-center bg-surface-canvas" data-remote-project-view={props.tab.token}>
      <Show when={error()}>
        {(message) => (
          <p class="text-sm text-secondary p-4 break-words" role="alert">
            {t("folderSelection.servers.errorTitle")}: {message()}
          </p>
        )}
      </Show>
    </div>
  )
}
