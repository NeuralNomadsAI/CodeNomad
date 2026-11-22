import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type Component } from "solid-js"
import { Portal } from "solid-js/web"
import { useI18n } from "../lib/i18n"
import { showAlertDialog, showPromptDialog } from "../stores/alerts"
import { previewKey, sessionPreviews, openSessionPreview, dismissSessionPreview, showSessionChatFor, updateSessionPreviewLocation, updateSessionPreviewHistory, updateSessionPreviewViewport, cancelSessionPreviewNavigation, startSessionPreviewNavigation, previewBlockedByOwner, previewOwnershipRevision, focusPreviewOwner, requestSessionPreview, type SessionPreviewRecord } from "../stores/session-previews"
import { BrowserFrame, type BrowserFrameElementTarget } from "./browser-frame"
import { getPreviewFrameSource } from "./browser-frame-security"
import { runtimeEnv } from "../lib/runtime-env"
import { remotePreviewAddress, remotePreviewContent, remotePreviewSource } from "../lib/remote-preview-address"
import type { RemotePreviewCapability } from "../../../server/src/api-types"
import { claimNativeBrowserOpen, hasNativePreviewOwnership } from "../lib/native/browser"

interface SessionPreviewViewProps {
  preview: SessionPreviewRecord
  instanceId: string
  active?: boolean
  onInsertComment: (markdown: string) => void
}

type PreviewSlot = { sessionId: string; instanceId: string; element: HTMLDivElement; insertComment: (markdown: string) => void }
const [slot, setSlot] = createSignal<PreviewSlot>()

/** Geometry moves; the guest's DOM stays attached throughout tab switches. */
export const SessionPreviewSlot: Component<{ sessionId: string; instanceId: string; active: boolean; onInsertComment: (markdown: string) => void }> = props => {
  const { t } = useI18n()
  const conflict = () => previewBlockedByOwner(props.sessionId, props.instanceId)
  const handleError = (error: unknown) => showAlertDialog(t("sessionPreview.open.title"), {
    title: t("sessionPreview.open.title"), detail: error instanceof Error ? error.message : String(error), variant: "error",
  })
  let element!: HTMLDivElement
  createEffect(() => {
    if (!props.active) return
    const current = { element, sessionId: props.sessionId, instanceId: props.instanceId, insertComment: props.onInsertComment }
    setSlot(current)
    onCleanup(() => setSlot(previous => previous === current ? undefined : previous))
  })
  return <div ref={element} class="flex-1 min-h-0" style={{ display: props.active ? undefined : "none" }}>
    <Show when={props.active && conflict()}>{blocked => <div class="h-full flex flex-col items-center justify-center gap-3 bg-surface-canvas">
      <div role="status">{t("sessionPreview.owner.otherTab")}</div>
      <div class="flex flex-wrap justify-center gap-2">
        <button class="button-secondary" type="button" onClick={() => {
          void focusPreviewOwner(props.sessionId, props.instanceId)?.catch(handleError)
        }}>{t("sessionPreview.owner.go")}</button>
        <Show when={blocked().owner.sameWindow}>
          <button class="button-secondary" type="button" onClick={() => {
            const { url, revision } = blocked()
            void requestSessionPreview(props.sessionId, props.instanceId, url, revision).catch(handleError)
          }}>{t("sessionPreview.owner.transfer")}</button>
        </Show>
      </div>
    </div>}</Show>
  </div>
}

export const SessionPreviewHost: Component = () => {
  const ids = createMemo<string[]>((previous) => {
    const wanted = new Set(sessionPreviews().keys())
    return [...previous.filter(id => wanted.delete(id)), ...wanted]
  }, [])
  const [bounds, setBounds] = createSignal<DOMRect>()
  const [covered, setCovered] = createSignal(false)
  createEffect(() => {
    const current = slot()
    if (!current) { setBounds(undefined); return }
    const shell = current.element.closest(".session-shell-frame")!
    const measure = () => {
      setBounds(current.element.getBoundingClientRect())
      setCovered(Boolean(shell.querySelector(".session-floating-drawer")))
    }
    const observer = new ResizeObserver(measure)
    const drawers = new MutationObserver(measure)
    observer.observe(current.element)
    drawers.observe(shell, { childList: true, subtree: true })
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    measure()
    onCleanup(() => { observer.disconnect(); drawers.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true) })
  })
  return <Portal><For each={ids()}>{id => {
    const preview = createMemo<SessionPreviewRecord>(previous => sessionPreviews().get(id) ?? previous, untrack(() => sessionPreviews().get(id)!))
    const activeSlot = () => {
      const current = slot()
      return !covered() && current && previewKey(current.sessionId, current.instanceId) === id
        && (!hasNativePreviewOwnership() || current.instanceId === preview().instanceId) ? current : undefined
    }
    return <div data-session-id={preview().sessionId} data-preview-instance={activeSlot()?.instanceId} style={{
      position: "fixed", display: activeSlot() ? "flex" : "none", "z-index": 1,
      left: `${bounds()?.x ?? 0}px`, top: `${bounds()?.y ?? 0}px`, width: `${bounds()?.width ?? 0}px`, height: `${bounds()?.height ?? 0}px`,
    }}><SessionPreviewView preview={preview()} instanceId={activeSlot()?.instanceId ?? (hasNativePreviewOwnership() ? preview().instanceId : "")} active={Boolean(activeSlot() && bounds()?.width && bounds()?.height)}
      onInsertComment={text => activeSlot()?.insertComment(text)} /></div>
  }}</For></Portal>
}

function describeElement(target: BrowserFrameElementTarget): string {
  const label = target.ariaLabel || target.text
  const role = target.role ? ` role="${target.role}"` : ""
  return label ? `${target.tagName}${role} "${label}"` : `${target.tagName}${role}`
}

function buildCommentMarkdown(target: BrowserFrameElementTarget, comment: string): string {
  const lines = [
    "> Web preview comment",
    `> Page: \`${target.pagePath}\``,
    `> Element: \`${describeElement(target)}\``,
  ]
  if (target.selector) {
    lines.push(`> Selector: \`${target.selector}\``)
  }
  return `${lines.join("\n")}\n\n${comment}\n\n`
}

const SessionPreviewView: Component<SessionPreviewViewProps> = (props) => {
  const { t } = useI18n()
  let reportedOpen: SessionPreviewRecord["nativeOpen"]
  const [commentMode, setCommentMode] = createSignal(false)
  function showNavigationError(error: unknown) {
    if (props.active === false || props.preview.owner.signal.aborted) return
    if (error instanceof Error && error.name === "AbortError") return
    showAlertDialog(t("sessionPreview.open.title"), {
      title: t("sessionPreview.open.title"),
      detail: error instanceof Error ? error.message : String(error),
      variant: "error",
    })
  }

  const content = () => props.preview.capability ? remotePreviewContent(props.preview as RemotePreviewCapability) : undefined
  const frameSource = (preview: SessionPreviewRecord = props.preview) =>
    getPreviewFrameSource(runtimeEnv, preview, window.location.href, preview.owner.client.id)

  async function handleCommentTarget(elementTarget: BrowserFrameElementTarget) {
    const preview = props.preview
    const comment = await showPromptDialog(t("sessionPreview.comment.prompt"), {
      title: t("sessionPreview.comment.title"),
      inputLabel: t("sessionPreview.comment.label"),
      confirmLabel: t("sessionPreview.comment.add"),
      cancelLabel: t("sessionPreview.comment.cancel"),
    })
    const normalized = comment?.trim()
    if (!normalized || preview !== props.preview || preview.owner.signal.aborted) return
    props.onInsertComment(buildCommentMarkdown(elementTarget, normalized))
  }

  return (
    <div class="window-shell flex flex-1 min-h-0 flex-col bg-surface-canvas" style={{ display: props.active === false ? "none" : "flex" }} inert={props.active === false} aria-hidden={props.active === false}>
      <BrowserFrame
        active={props.active}
        instanceId={props.preview.capability ? undefined : props.instanceId}
        openRequestId={props.preview.nativeOpen?.requestID}
        interruptedOpenId={props.preview.interruptedOpenId}
        ownershipRevision={previewOwnershipRevision(props.preview.sessionId, props.instanceId)}
        onNativeRegistration={async registrationId => {
          const request = props.preview.nativeOpen
          if (!request || request === reportedOpen || request.instanceId !== props.instanceId) return false
          reportedOpen = request
          return claimNativeBrowserOpen(request.requestID,
            { kind: "target", instanceId: request.instanceId, registrationId }).catch(() => false)
        }}
        onClose={() => props.preview.capability ? dismissSessionPreview(props.preview.storageKey) : showSessionChatFor(props.preview.sessionId, props.instanceId)}
        sessionId={props.preview.sessionId}
        title={t("sessionPreview.title")}
        initialUrl={frameSource()}
        initialAddress={props.preview.targetUrl}
        initialHistory={props.preview.history}
        initialViewport={props.preview.viewport}
        onViewportChange={viewport => updateSessionPreviewViewport(props.preview.storageKey, viewport)}
        onHistoryChange={(history) => updateSessionPreviewHistory(props.preview.storageKey, history)}
        onNavigationStart={() => startSessionPreviewNavigation(props.preview.sessionId, props.instanceId)}
        onCancelNavigation={() => cancelSessionPreviewNavigation(props.preview.storageKey)}
        proxyBasePath={content()?.prefix ?? `/previews/${encodeURIComponent(props.preview.token)}`}
        addressMode="url"
        isolatedSource={Boolean(props.preview.capability)}
        opaqueSource={content()?.opaque}
        sourceAddress={source => remotePreviewAddress(props.preview as RemotePreviewCapability, source)}
        onNavigate={async (address) => {
          const source = props.preview.capability && remotePreviewSource(props.preview as RemotePreviewCapability, address)
          return source || frameSource(await openSessionPreview(props.preview.sessionId, address, props.instanceId))
        }}
        onNavigationError={showNavigationError}
        onFrameLocation={(path) => {
          const target = new URL(path, props.preview.targetUrl)
          if (props.preview.capability && target.origin !== new URL(props.preview.targetUrl).origin) return
          updateSessionPreviewLocation(props.preview.storageKey, target.href)
          return target.href
        }}
        commentBridge
        labels={{
          back: t("sidecars.back"),
          forward: t("sessionPreview.forward"),
          refresh: t("sidecars.refresh"),
          path: t("sessionPreview.open.label"),
          invalidUrl: t("sessionPreview.open.invalidUrl"),
          go: t("sidecars.go"),
          viewport: t("browserFrame.viewport"),
          viewportResponsive: t("browserFrame.viewport.responsive"),
          viewportDesktop: t("browserFrame.viewport.desktop"),
          viewportTablet: t("browserFrame.viewport.tablet"),
          viewportTabletLandscape: t("browserFrame.viewport.tabletLandscape"),
          viewportMobile: t("browserFrame.viewport.mobile"),
          viewportMobileLandscape: t("browserFrame.viewport.mobileLandscape"),
          commentMode: t("sessionPreview.comment.mode"),
        }}
        commentMode={commentMode()}
        onToggleCommentMode={() => setCommentMode((value) => !value)}
        onCommentTarget={(target) => void handleCommentTarget(target)}
      />
    </div>
  )
}
