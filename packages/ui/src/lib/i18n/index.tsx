import { createContext, createEffect, createMemo, createSignal, onCleanup, onMount, useContext } from "solid-js"
import type { ParentComponent } from "solid-js"
import { useConfig } from "../../stores/preferences"
import { enMessages } from "./messages/en"

type Messages = Record<string, string>

export type TranslateParams = Record<string, unknown>

export type Locale = "en" | "es" | "fr" | "ru" | "ja" | "zh-Hans" | "he"

const SUPPORTED_LOCALES: readonly Locale[] = ["en", "es", "fr", "ru", "ja", "zh-Hans", "he"] as const
const SUPPORTED_LOCALES_BY_LOWER = new Map(SUPPORTED_LOCALES.map((locale) => [locale.toLowerCase(), locale]))
const RTL_LOCALES = new Set<Locale>(["he"])

const localeMessagesCache = new Map<Locale, Messages>([["en", enMessages]])
const localeMessagesPromises = new Map<Locale, Promise<Messages>>()

const localeLoaders: Record<Locale, () => Promise<Messages>> = {
  en: async () => enMessages,
  es: async () => (await import("./messages/es")).esMessages,
  fr: async () => (await import("./messages/fr")).frMessages,
  ru: async () => (await import("./messages/ru")).ruMessages,
  ja: async () => (await import("./messages/ja")).jaMessages,
  "zh-Hans": async () => (await import("./messages/zh-Hans")).zhHansMessages,
  he: async () => (await import("./messages/he")).heMessages,
}

function getLocaleDirection(locale: Locale): "ltr" | "rtl" {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr"
}

function normalizeLocaleTag(value: string): string {
  return value.trim().replace(/_/g, "-")
}

function matchSupportedLocale(value: string | undefined): Locale | null {
  if (!value) return null

  const normalized = normalizeLocaleTag(value)
  const lower = normalized.toLowerCase()
  const exact = SUPPORTED_LOCALES_BY_LOWER.get(lower)
  if (exact) return exact

  const parts = lower.split("-")
  const base = parts[0]
  if (!base) return null

  if (base === "zh") {
    const zhHans = SUPPORTED_LOCALES_BY_LOWER.get("zh-hans")
    return zhHans ?? null
  }

  const baseMatch = SUPPORTED_LOCALES_BY_LOWER.get(base)
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
let globalMessages: Messages = enMessages
let globalLocale: Locale = "en"

function getMessagesForLocale(locale: Locale): Messages {
  return localeMessagesCache.get(locale) ?? enMessages
}

async function loadLocaleMessages(locale: Locale): Promise<Messages> {
  const cached = localeMessagesCache.get(locale)
  if (cached) {
    return cached
  }

  const pending = localeMessagesPromises.get(locale)
  if (pending) {
    return pending
  }

  const loader = localeLoaders[locale]
  const promise = loader()
    .then((messages) => {
      localeMessagesCache.set(locale, messages)
      localeMessagesPromises.delete(locale)
      return messages
    })
    .catch((error) => {
      localeMessagesPromises.delete(locale)
      throw error
    })

  localeMessagesPromises.set(locale, promise)
  return promise
}

export async function preloadLocaleMessages(preferredLocale?: string | null): Promise<Locale> {
  const resolvedLocale = matchSupportedLocale(preferredLocale ?? undefined) ?? detectNavigatorLocale() ?? "en"
  try {
    globalMessages = await loadLocaleMessages(resolvedLocale)
    globalLocale = resolvedLocale
    setGlobalRevision((value) => value + 1)
    return resolvedLocale
  } catch {
    globalMessages = enMessages
    globalLocale = "en"
    setGlobalRevision((value) => value + 1)
    return "en"
  }
}

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
  const [detectedLocale, setDetectedLocale] = createSignal<Locale>(globalLocale)
  const [resolvedLocale, setResolvedLocale] = createSignal<Locale>(globalLocale)
  const previousGlobalMessages = globalMessages
  const previousGlobalLocale = globalLocale
  const previousDocumentLanguage = typeof document !== "undefined" ? document.documentElement.lang : ""
  const previousDocumentDirection = typeof document !== "undefined" ? document.documentElement.dir : ""

  onMount(() => {
    const detected = detectNavigatorLocale()
    if (detected) setDetectedLocale(detected)
  })

  const locale = createMemo<Locale>(() => {
    const configured = matchSupportedLocale(preferences().locale)
    return configured ?? detectedLocale() ?? "en"
  })

  const messages = createMemo<Messages>(() => getMessagesForLocale(resolvedLocale()))

  function t(key: string, params?: TranslateParams): string {
    return translateFrom(messages(), key, params)
  }

  createEffect(() => {
    const nextLocale = locale()
    let cancelled = false

    void loadLocaleMessages(nextLocale)
      .then((loadedMessages) => {
        if (cancelled) {
          return
        }
        setResolvedLocale(nextLocale)
        globalLocale = nextLocale
        globalMessages = loadedMessages
        setGlobalRevision((value) => value + 1)
      })
      .catch(() => {
        if (cancelled) {
          return
        }
        setResolvedLocale("en")
        globalMessages = enMessages
        globalLocale = "en"
        setGlobalRevision((value) => value + 1)
      })

    onCleanup(() => {
      cancelled = true
    })
  })

  createEffect(() => {
    if (typeof document === "undefined") return
    const activeLocale = locale()
    document.documentElement.dir = getLocaleDirection(activeLocale)
    document.documentElement.lang = activeLocale
  })

  onCleanup(() => {
    globalMessages = previousGlobalMessages
    globalLocale = previousGlobalLocale
    setGlobalRevision((value) => value + 1)
    if (typeof document !== "undefined") {
      document.documentElement.lang = previousDocumentLanguage
      document.documentElement.dir = previousDocumentDirection
    }
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
