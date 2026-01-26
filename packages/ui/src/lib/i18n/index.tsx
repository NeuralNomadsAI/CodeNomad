import { createContext, createEffect, createMemo, createSignal, onCleanup, onMount, useContext } from "solid-js"
import type { ParentComponent } from "solid-js"
import { useConfig } from "../../stores/preferences"
import { enMessages } from "./messages/en/index"

type Messages = Record<string, string>

export type TranslateParams = Record<string, unknown>

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

function translateFrom(messages: Messages, key: string, params?: TranslateParams): string {
  const current = messages[key]
  const fallback = enMessages[key as keyof typeof enMessages]
  const template = current ?? fallback ?? key
  return interpolate(template, params)
}

const [globalRevision, setGlobalRevision] = createSignal(0)
const initialGlobalLocale: Locale = detectNavigatorLocale() ?? "en"
let globalMessages: Messages = messagesByLocale[initialGlobalLocale]

export function tGlobal(key: string, params?: TranslateParams): string {
  globalRevision()
  return translateFrom(globalMessages, key, params)
}

export interface I18nContextValue {
  locale: () => Locale
  t: (key: string, params?: TranslateParams) => string
}

const I18nContext = createContext<I18nContextValue>()

export const I18nProvider: ParentComponent = (props) => {
  const { preferences } = useConfig()
  const [detectedLocale, setDetectedLocale] = createSignal<Locale>("en")

  const previousMessages = globalMessages

  onMount(() => {
    const detected = detectNavigatorLocale()
    if (detected) setDetectedLocale(detected)
  })

  const locale = createMemo<Locale>(() => {
    const configured = matchSupportedLocale(preferences().locale)
    return configured ?? detectedLocale() ?? "en"
  })

  const messages = createMemo<Messages>(() => messagesByLocale[locale()])

  function t(key: string, params?: TranslateParams): string {
    return translateFrom(messages(), key, params)
  }

  createEffect(() => {
    globalMessages = messages()
    setGlobalRevision((value) => value + 1)
  })

  onCleanup(() => {
    globalMessages = previousMessages
    setGlobalRevision((value) => value + 1)
  })

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
