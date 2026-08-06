import assert from "node:assert/strict"
import { test } from "node:test"

import {
  readUseTauriNativeEventTransportPreference,
  TAURI_NATIVE_EVENT_TRANSPORT_STORAGE_KEY,
} from "./desktop-event-transport-preference"

function withStoredPreference(value: string | null, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => key === TAURI_NATIVE_EVENT_TRANSPORT_STORAGE_KEY ? value : null,
      },
    },
  })
  try {
    run()
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else delete (globalThis as { window?: unknown }).window
  }
}

test("the native Tauri event transport requires explicit opt-in", () => {
  withStoredPreference(null, () => assert.equal(readUseTauriNativeEventTransportPreference(), false))
  withStoredPreference("0", () => assert.equal(readUseTauriNativeEventTransportPreference(), false))
  withStoredPreference("1", () => assert.equal(readUseTauriNativeEventTransportPreference(), true))
})
