import { createContext, createEffect, createMemo, createSignal, onCleanup, onMount, useContext } from "solid-js"
import { isServer } from "solid-js/web"
import type { ParentComponent } from "solid-js"
import { useConfig } from "../../stores/preferences"
import { enMessages } from "./messages/en"
import type { Locale, Messages, TranslateParams } from "./types"

const localeMessagesCache = new Map<Locale, Messages>([
  ["en", enMessages],
])
const localeMessagesPromises = new Map<Locale, Promise<Messages>>()

const localeLoaders: Record<Locale, () => Promise<Messages>> = {
  en: () => Promise.resolve(enMessages),
}

function matchSupportedLocale(locale?: string | null): Locale | null {
  if (!locale) return null
  const base = locale.split("-")[0].toLowerCase()
  if (base === "en") return "en"
  return null
}

function detectNavigatorLocale(): Locale | null {
  if (isServer || typeof navigator === "undefined") return null

  try {
    const candidates = Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : navigator.language
        ? [navigator.language]
        : []

    for (const candidate of candidates) {
      const match = matchSupportedLocale(candidate)
      if (match) return match
    }
  } catch {
    // Ignore navigator errors in test environments
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
  if (cached) return cached

  const pending = localeMessagesPromises.get(locale)
  if (pending) return pending

  const loader = localeLoaders[locale]
  if (!loader) return enMessages

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
  if (isServer) return <>{props.children}</>

  const { preferences } = useConfig()
  const [detectedLocale, setDetectedLocale] = createSignal<Locale>(globalLocale)
  const [resolvedLocale, setResolvedLocale] = createSignal<Locale>(globalLocale)
  const previousGlobalMessages = globalMessages
  const previousGlobalLocale = globalLocale
  const previousDocumentLanguage = typeof document !== "undefined" ? document.documentElement.lang : ""
  const previousDocumentDirection = typeof document !== "undefined" ? document.documentElement.dir : ""

  onMount(() => {
    try {
      const detected = detectNavigatorLocale()
      if (detected) setDetectedLocale(detected)
    } catch {}
  })

  const locale = createMemo<Locale>(() => {
    try {
      const configured = matchSupportedLocale(preferences().locale)
      return configured ?? detectedLocale() ?? "en"
    } catch {
      return "en"
    }
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
        if (cancelled) return
        setResolvedLocale(nextLocale)
        globalLocale = nextLocale
        globalMessages = loadedMessages
        setGlobalRevision((value) => value + 1)
      })
      .catch(() => {
        if (cancelled) return
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
    try {
      const activeLocale = locale()
      const direction = activeLocale === "ar" ? "rtl" : "ltr" // simplified
      document.documentElement.dir = direction
      document.documentElement.lang = activeLocale
    } catch {}
  })

  onCleanup(() => {
    globalMessages = previousGlobalMessages
    globalLocale = previousGlobalLocale
    setGlobalRevision((value) => value + 1)
    if (typeof document !== "undefined") {
      try {
        document.documentElement.lang = previousDocumentLanguage
        document.documentElement.dir = previousDocumentDirection
      } catch {}
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

export function t(key: string, params?: TranslateParams): string {
  return tGlobal(key, params)
}

export type { Locale, TranslateParams } from "./types"
