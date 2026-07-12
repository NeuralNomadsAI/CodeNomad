export const TAURI_NATIVE_EVENT_TRANSPORT_STORAGE_KEY = "codenomad-use-tauri-native-event-transport"

export function readUseTauriNativeEventTransportPreference(): boolean {
  if (typeof window === "undefined") {
    return true
  }

  try {
    return window.localStorage?.getItem(TAURI_NATIVE_EVENT_TRANSPORT_STORAGE_KEY) !== "0"
  } catch {
    return true
  }
}

export function writeUseTauriNativeEventTransportPreference(enabled: boolean): void {
  if (typeof window === "undefined") {
    return
  }

  try {
    window.localStorage?.setItem(TAURI_NATIVE_EVENT_TRANSPORT_STORAGE_KEY, enabled ? "1" : "0")
  } catch {
    // Ignore localStorage failures and keep the in-memory preference only.
  }
}
