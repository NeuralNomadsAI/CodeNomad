import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { embeddedProjectUrl, readEmbeddedProjectReport } from "../lib/embed-mode"
import { localOverlayOpen } from "../lib/native/browser"
import { closeRemoteView, onRemoteViewUpdated, openRemoteView, updateRemoteView } from "../lib/native/remote-view"
import { getLogger } from "../lib/logger"
import { recordRemoteProjectRecent, remoteServers } from "../stores/preferences"
import { patchRemoteProjectTab, type RemoteProjectTabRecord } from "../stores/remote-project-tabs"
import RemoteViewSession from "./remote-view-session"
import type { RemoteViewOpenPayload } from "../lib/native/remote-view"
import type { RemoteServerProfile } from "../../../server/src/api-types"

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
  const profile = createMemo(() => remoteServers().find((entry) => entry.id === props.tab.profileId), undefined,
    { equals: (left, right) => JSON.stringify(left) === JSON.stringify(right) })
  return <Show when={profile()} keyed
    fallback={<p role="alert">{t("folderSelection.remoteProject.serverMissing")}</p>}>
    {(profile) => <RemoteProjectContent {...props} profile={profile} />}
  </Show>
}

const RemoteProjectContent: Component<RemoteProjectViewProps & { profile: RemoteServerProfile }> = (props) => {
  const { t } = useI18n()
  const [error, setError] = createSignal<string>()
  const [sessionNeeded, setSessionNeeded] = createSignal(false)
  let acceptSession: (cookie: RemoteViewOpenPayload["cookie"]) => void = () => {}
  let retry = () => {}
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

    const fail = (cause?: unknown) => {
      failed = true
      pending = false
      log.warn("Remote project view failed", { profileId, cause: cause instanceof Error ? cause.message : String(cause) })
      if (!disposed) setError(t("remoteBrowse.unreachable"))
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
        const profile = props.profile
        pending = true
        const origin = new URL(profile.baseUrl).origin
        acceptSession = (cookie) => {
          unlisten()
          void onRemoteViewUpdated((update) => {
            if (disposed || update.viewId !== token) return
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
              url: embeddedProjectUrl(profile.baseUrl, props.tab.folder),
              cookie,
            }, rect)
            opened = true
            lastBounds = key
            pending = false
            setSessionNeeded(false)
            patchRemoteProjectTab(token, { entryUrl: undefined })
            if (disposed) void closeRemoteView(token).catch(() => {})
            else sync()
          }).catch(fail)
        }
        setSessionNeeded(true)
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

    retry = () => { failed = false; pending = false; lastBounds = ""; setError(undefined); sync() }

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
      <Show when={sessionNeeded() && !error()}>
        <RemoteViewSession profile={props.profile} active={props.active} onReady={(cookie) => acceptSession(cookie)} />
      </Show>
      <Show when={error()}>
        {(message) => (
          <div class="text-sm text-secondary p-4 break-words"><p role="alert">
            {t("folderSelection.servers.errorTitle")}: {message()}
          </p><button type="button" class="browse-menu-row" onClick={() => retry()}>{t("filesystemBrowser.actions.retry")}</button></div>
        )}
      </Show>
    </div>
  )
}
