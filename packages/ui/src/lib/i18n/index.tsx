import { createContext, createMemo, createSignal, onMount, useContext } from "solid-js"
import type { ParentComponent } from "solid-js"
import { useConfig } from "../../stores/preferences"
import { enMessages } from "./messages/en"

type Messages = Record<string, string>

export type Locale = "en"

const SUPPORTED_LOCALES: readonly Locale[] = ["en"] as const

const messagesByLocale: Record<Locale, Messages> = {
  en: enMessages,
}

function normalizeLocaleTag(value: string): string {
  return value.trim().replace(/_/g, "-")
}

function matchSupportedLocale(value: string | undefined): Locale | null {
  if (!value) return null

  const normalized = normalizeLocaleTag(value)
  const lower = normalized.toLowerCase()
  const supportedLower = new Map(SUPPORTED_LOCALES.map((locale) => [locale.toLowerCase(), locale]))
  const exact = supportedLower.get(lower)
  if (exact) return exact

  const base = lower.split("-")[0]
  if (!base) return null
  const baseMatch = supportedLower.get(base)
  return baseMatch ?? null
}

function detectNavigatorLocale(): Locale | null {
  if (typeof navigator === "undefined") return null

  const candidates = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : []

  for (const candidate of candidates) {
    const match = matchSupportedLocale(candidate)
    if (match) return match
  }

  return null
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key]
    return value === undefined || value === null ? "" : String(value)
  })
}

export interface I18nContextValue {
  locale: () => Locale
  t: (key: string, params?: Record<string, unknown>) => string
}

const I18nContext = createContext<I18nContextValue>()

export const I18nProvider: ParentComponent = (props) => {
  const { preferences } = useConfig()
  const [detectedLocale, setDetectedLocale] = createSignal<Locale>("en")

  onMount(() => {
    const detected = detectNavigatorLocale()
    if (detected) setDetectedLocale(detected)
  })

  const locale = createMemo<Locale>(() => {
    const configured = matchSupportedLocale(preferences().locale)
    return configured ?? detectedLocale() ?? "en"
  })

  const messages = createMemo<Messages>(() => messagesByLocale[locale()])

  function t(key: string, params?: Record<string, unknown>): string {
    const current = messages()[key]
    const fallback = enMessages[key as keyof typeof enMessages]
    const template = current ?? fallback ?? key
    return interpolate(template, params)
  }

  const value: I18nContextValue = {
    locale,
    t,
  }

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider")
  }
  return context
}
