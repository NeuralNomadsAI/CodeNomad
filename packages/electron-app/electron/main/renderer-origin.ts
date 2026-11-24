export function isAllowedRendererOrigin(origin: string | undefined | null, allowedOrigins: string[]): boolean {
  if (!origin) return false
  try {
    return allowedOrigins.includes(new URL(origin).origin)
  } catch {
    return false
  }
}

export function resolveConfiguredRendererOrigins(
  currentCliUrl: string | null,
  isPackaged: boolean,
  devCandidates: Array<string | undefined>,
): string[] {
  const candidates = isPackaged ? [currentCliUrl] : [currentCliUrl, ...devCandidates]
  const origins = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      origins.add(new URL(candidate).origin)
    } catch {}
  }
  return [...origins]
}
