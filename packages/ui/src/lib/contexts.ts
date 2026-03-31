import { createContext } from "solid-js";

// --- I18n Types ---
export type Locale = "en" | "zh" | "ja" | "ko" | "es" | "fr" | "de" | "it" | "pt" | "ru";

export interface I18nContextValue {
  locale: () => Locale
  t: (key: string, params?: Record<string, any>) => string
}

// --- Config Types (Simplified for context leaf) ---
// We use 'any' for the complex value type to avoid circular imports of the huge preferences.tsx file,
// but we keep the interface name for type safety where used.
export type ConfigContextValue = any; 

// --- Stable global context keys ---
const CONFIG_CONTEXT_KEY = Symbol.for("codenomad.ui.config.context");
const I18N_CONTEXT_KEY = Symbol.for("codenomad.ui.i18n.context");

/**
 * Access the global ConfigContext object. 
 */
export const ConfigContext = (globalThis as any)[CONFIG_CONTEXT_KEY] || 
  ((globalThis as any)[CONFIG_CONTEXT_KEY] = createContext<ConfigContextValue>());

/**
 * Access the global I18nContext object.
 */
export const I18nContext = (globalThis as any)[I18N_CONTEXT_KEY] || 
  ((globalThis as any)[I18N_CONTEXT_KEY] = createContext<I18nContextValue>());
