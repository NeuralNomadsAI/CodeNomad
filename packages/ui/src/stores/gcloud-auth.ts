import { createSignal } from "solid-js"

// GCloud authentication state
const [gcloudAuthenticated, setGcloudAuthenticated] = createSignal(false)
const [gcloudExpired, setGcloudExpired] = createSignal(false)
const [gcloudAccountValue, setGcloudAccount] = createSignal<string | null>(null)
const [gcloudProjectValue, setGcloudProject] = createSignal<string | null>(null)
const [gcloudTokenExpiryValue, setGcloudTokenExpiry] = createSignal<Date | null>(null)
const [gcloudLoading, setGcloudLoading] = createSignal(false)

export function isGCloudAuthenticated(): boolean {
  return gcloudAuthenticated()
}

export function isGCloudExpired(): boolean {
  return gcloudExpired()
}

export function gcloudAccount(): string | null {
  return gcloudAccountValue()
}

export function gcloudProject(): string | null {
  return gcloudProjectValue()
}

export function gcloudTokenExpiry(): Date | null {
  return gcloudTokenExpiryValue()
}

export function isGCloudLoading(): boolean {
  return gcloudLoading()
}

export function formatTokenExpiry(expiry: Date | null): string {
  if (!expiry) return "Unknown"
  return expiry.toLocaleString()
}

export async function checkGCloudAuth(): Promise<void> {
  setGcloudLoading(true)
  try {
    // Stub - would check gcloud auth status
    setGcloudAuthenticated(false)
  } finally {
    setGcloudLoading(false)
  }
}

export async function gcloudLogout(): Promise<void> {
  setGcloudLoading(true)
  try {
    setGcloudAuthenticated(false)
    setGcloudAccount(null)
    setGcloudProject(null)
    setGcloudTokenExpiry(null)
  } finally {
    setGcloudLoading(false)
  }
}
