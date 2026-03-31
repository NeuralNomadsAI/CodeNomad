import { createContext } from "solid-js";

export interface I18nContextValue {
  language: () => string
  setLanguage: (lang: string) => void
  t: (key: string, params?: Record<string, any>) => string
}

const I18N_CONTEXT_KEY = Symbol.for("codenomad.i18n.context");
export const I18nContext = (globalThis as any)[I18N_CONTEXT_KEY] || ((globalThis as any)[I18N_CONTEXT_KEY] = createContext<I18nContextValue>());
