import { LIVE_VOICE_CONSENT_PATH, LIVE_VOICE_NOTICE_VERSION, type LiveVoiceEngine } from "../../../server/src/speech/live-voice-contract"
import { speechCapabilities } from "../stores/speech"
import { authenticatedFetch } from "./auth-recovery"
import { isDesktopHost, isNativeApplicationWindow, isRemoteWindow, isTauriHost } from "./runtime-env"

const grants = new Set<string>()
const desktopProfile = () => isDesktopHost() && isNativeApplicationWindow() && speechCapabilities()?.desktopVoiceConversationEngine === true
const canPersistInBrowser = () => !(isDesktopHost() && isNativeApplicationWindow()) &&
  // macOS remote WebKit stores are keyed by remote registration across app profiles.
  !(isTauriHost() && isRemoteWindow() && /\bMacintosh\b/.test(navigator.userAgent))
const consentKey = (server: string, engine: LiveVoiceEngine) =>
  `codenomad:live-voice-consent:${JSON.stringify([server, engine, LIVE_VOICE_NOTICE_VERSION])}`

export function hasLiveVoiceConsent(server: string, engine: LiveVoiceEngine): boolean {
  const key = consentKey(server, engine)
  if (grants.has(key)) return true
  if (desktopProfile()) return speechCapabilities()?.desktopLiveVoiceConsent?.[engine] === LIVE_VOICE_NOTICE_VERSION
  if (!canPersistInBrowser()) return false
  try { return localStorage.getItem(key) === "accepted" } catch { return false }
}

export function rememberLiveVoiceConsent(server: string, engine: LiveVoiceEngine) {
  const key = consentKey(server, engine)
  grants.add(key)
  if (desktopProfile()) {
    void authenticatedFetch(new URL(LIVE_VOICE_CONSENT_PATH, server).href, {
      method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine, version: LIVE_VOICE_NOTICE_VERSION }),
    }).catch(() => { /* The acceptance remains valid for the current document. */ })
  } else if (canPersistInBrowser()) {
    try { localStorage.setItem(key, "accepted") } catch { /* The current document still owns its grant. */ }
  }
}
