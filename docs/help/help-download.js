// First-party, download page only. Reveals the build-time link for this device; no requests.
// Returns "windows", "macos", "linux", "mobile" or null (no offered build: the table remains the path).
function detectDownloadPlatform(nav) {
  const data = nav.userAgentData || {}
  const hint = typeof data.platform === 'string' ? data.platform : ''
  const legacy = String(nav.platform || '')
  const agent = String(nav.userAgent || '')
  const touch = Number(nav.maxTouchPoints) || 0
  // Phones and tablets first: Android reports Linux, and iPadOS reports a Mac with touch points.
  if (data.mobile === true || hint === 'Android' || hint === 'iOS' || /Android|iPhone|iPad|iPod/.test(agent) || /^(?:iPhone|iPad|iPod)/.test(legacy)) return 'mobile'
  if (touch > 1 && (hint === 'macOS' || /^Mac/.test(legacy) || /Macintosh/.test(agent))) return 'mobile'
  const desktop = hint
    ? { Windows: 'windows', macOS: 'macos', Linux: 'linux' }[hint]
    : /^Win/.test(legacy) || /Windows NT/.test(agent) ? 'windows'
      : /^Mac/.test(legacy) || /Macintosh/.test(agent) ? 'macos'
        : /Linux/.test(legacy) || /Linux/.test(agent) ? 'linux' : null
  if (typeof desktop !== 'string') return null
  // Windows on ARM runs the x64 build; no ChromeOS or ARM Linux build is offered.
  if (desktop === 'linux' && (/CrOS/.test(agent) || /\b(?:aarch64|arm\w*)\b/i.test(`${legacy} ${agent}`))) return null
  return desktop
}

(() => {
  try {
    const host = document.querySelector('.download-primary')
    const platform = host && detectDownloadPlatform(navigator)
    const choice = platform && host.querySelector(`[data-download-os="${platform}"]`)
    const link = choice && choice.querySelector('a.download-main')
    if (!link || !link.getAttribute('href') || !link.textContent.trim()) return
    choice.hidden = false
    host.hidden = false
  } catch {
    // The full download table is always rendered; a failure leaves the button hidden.
  }
})()
