export type UiBootstrapTheme = "light" | "dark" | "system"

export interface UiBootstrapCacheSnapshot {
  theme?: UiBootstrapTheme | null
  locale?: string | null
}

const UI_BOOTSTRAP_CACHE_KEY = "codenomad:ui-bootstrap"

export function readUiBootstrapCache(): UiBootstrapCacheSnapshot {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(UI_BOOTSTRAP_CACHE_KEY)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as UiBootstrapCacheSnapshot
    if (!parsed || typeof parsed !== "object") {
      return {}
    }

    return {
      theme:
        parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
          ? parsed.theme
          : undefined,
      locale: typeof parsed.locale === "string" ? parsed.locale : undefined,
    }
  } catch {
    return {}
  }
}

export function writeUiBootstrapCache(snapshot: UiBootstrapCacheSnapshot) {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return
  }

  try {
    const previous = readUiBootstrapCache()
    const next: UiBootstrapCacheSnapshot = {
      theme: snapshot.theme === undefined ? previous.theme : snapshot.theme ?? undefined,
      locale: snapshot.locale === undefined ? previous.locale : snapshot.locale ?? undefined,
    }

    if (!next.theme && !next.locale) {
      window.localStorage.removeItem(UI_BOOTSTRAP_CACHE_KEY)
      return
    }

    window.localStorage.setItem(UI_BOOTSTRAP_CACHE_KEY, JSON.stringify(next))
  } catch {
    /* noop */
  }
}
