import type { UpdateFeed } from "../../../server/src/api-types"
import { tGlobal } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { showToastNotification, type ToastHandle } from "../lib/notifications"
import { openExternalUrl } from "../lib/external-url"
import { getServerMeta } from "../lib/server-meta"
import {
  checkDesktopUpdate,
  installDesktopUpdate,
  listenForDesktopUpdateFailure,
  takeDesktopUpdateFailure,
} from "../lib/native/updates"

const releasesUrl = "https://github.com/NeuralNomadsAI/CodeNomad/releases"
const log = getLogger("actions")
let busy = false
/** This document's install was accepted; its progress ends on a failure event. */
let installing = false
/** Toast history retains actions; an older offer re-checks instead of installing. */
let offer = 0
let notice: ToastHandle | undefined
let feed: UpdateFeed | undefined

/** Preview builds are prereleases, which the latest-release page omits; an
 * unknown feed uses the full list, which contains every offered release. */
const releasePage = () => feed === "stable" ? `${releasesUrl}/latest` : releasesUrl

function showProgress(message: string) {
  notice?.dismiss()
  notice = showToastNotification({ message, variant: "info", duration: Number.POSITIVE_INFINITY })
}

function failed(error?: unknown) {
  busy = false
  installing = false
  notice?.dismiss()
  if (error) log.error("Desktop update failed", error)
  notice = showToastNotification({
    message: tGlobal("releases.desktop.failed"), variant: "error", duration: Number.POSITIVE_INFINITY,
    action: { label: tGlobal("releases.upgradeRequired.action.getUpdate"), href: releasePage() },
  })
}

/** The native host hands each failure to the installing webview (including after
 * a reload), or to any local document once that webview is gone. */
async function claimFailure() {
  try {
    if (!await takeDesktopUpdateFailure()) return
    // A reloaded document has not read the feed that selects the release page.
    feed ??= await readFeed()
    failed()
  } catch (error) { log.error("Unable to read the desktop update status", error) }
}

export function observeDesktopUpdates(): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  void listenForDesktopUpdateFailure(() => {
    if (installing) {
      busy = false
      installing = false
      notice?.dismiss()
      notice = undefined
    }
    void claimFailure()
  }).then((listener) => {
    if (disposed) listener()
    else unlisten = listener
  }).catch((error) => log.error("Unable to observe desktop update failures", error))
  // A failed installer restores the backend, which reloads every window.
  void claimFailure()
  return () => { disposed = true; unlisten?.() }
}

async function install(version: string, checked: number) {
  if (busy) return
  if (checked !== offer) {
    // A retained offer from an earlier check must not consume the current one.
    await requestDesktopUpdate()
    return
  }
  offer++
  busy = true
  installing = true
  showProgress(tGlobal("releases.desktop.downloading"))
  try {
    await installDesktopUpdate(version)
    // A failed renderer flush or installer is reported asynchronously. On
    // success all windows close and the installed application relaunches.
    if (busy) showProgress(tGlobal("releases.desktop.restarting"))
  } catch (error) {
    // A recorded download failure also arrives as an event: whichever comes
    // first reports it. Unrecorded errors are reported while still installing.
    const claimed = await takeDesktopUpdateFailure().catch(() => false)
    if (claimed || installing) failed(error)
  }
}

const FEED_READ_TIMEOUT_MS = 5000

/** A stalled backend must not hold the update flow; native then derives the feed. */
async function readFeed(): Promise<UpdateFeed | undefined> {
  let timer: number | undefined
  try {
    const timeout = new Promise<undefined>((resolve) => { timer = window.setTimeout(resolve, FEED_READ_TIMEOUT_MS) })
    return (await Promise.race([getServerMeta(true), timeout]))?.updateFeed
  } catch (error) {
    log.warn("Unable to read the update feed", error)
    return undefined
  } finally { window.clearTimeout(timer) }
}

/**
 * Checks the saved update feed: stable releases, or previews and releases.
 * A notification passes its release page: a release it announces may not carry
 * an installable manifest yet, so "current" then opens that page instead.
 */
export async function requestDesktopUpdate(announcedRelease?: string): Promise<void> {
  if (busy) return
  busy = true
  showProgress(tGlobal("releases.desktop.checking"))
  const checked = ++offer
  try {
    // An unanswered read keeps the last known saved feed.
    feed = (await readFeed()) ?? feed
    const result = await checkDesktopUpdate(feed)
    notice?.dismiss()
    notice = undefined
    busy = false
    if (result.status !== "available" && announcedRelease) {
      await openExternalUrl(announcedRelease)
    } else if (result.status === "unsupported") {
      await openExternalUrl(releasePage())
    } else if (result.status === "current") {
      notice = showToastNotification({ message: tGlobal("releases.desktop.current"), variant: "success" })
    } else {
      notice = showToastNotification({
        message: tGlobal("releases.desktop.available", { version: result.version }),
        variant: "info", duration: Number.POSITIVE_INFINITY,
        action: {
          label: tGlobal("releases.desktop.install"), href: releasePage(),
          onClick: () => install(result.version, checked),
        },
      })
    }
  } catch (error) { failed(error) }
}
