const runtimeBase = typeof window !== "undefined" ? window.location?.origin : undefined
const defaultBase = typeof window !== "undefined" ? window.__CODENOMAD_API_BASE__ ?? runtimeBase : undefined

export const CODENOMAD_API_BASE = import.meta.env?.VITE_CODENOMAD_API_BASE ?? defaultBase
