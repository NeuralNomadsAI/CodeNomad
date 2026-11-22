// Embedded with its catalogue and theme so an unpaired device needs only this document.
const messages = __RUNE_WEB_PAIR_MESSAGES__
const page = new URL(location.href)
const code = page.hash.slice(1).trim()
history.replaceState(null, '', page.pathname + page.search)
const requested = [page.searchParams.get('locale'), ...navigator.languages, 'en']
const locale = requested.filter(Boolean).map(candidate => {
  const tag = candidate.toLowerCase().replaceAll('_', '-')
  const locales = Object.keys(messages)
  const language = tag.split('-')[0]
  return locales.find(key => key.toLowerCase() === tag) ?? (language === 'zh' ? 'zh-Hans' : locales.find(key => key === language))
}).find(Boolean)
const t = messages[locale]
document.documentElement.lang = locale
document.documentElement.dir = t.direction
document.title = t.title
document.querySelector('h1').textContent = t.heading
const guidance = document.querySelector('#pair-guidance')
const status = document.querySelector('#pair-status')
guidance.textContent = t.guidance
if (code && location.protocol === 'https:') {
  status.textContent = t.loading
  try {
    const response = await fetch('/api/remote-control/pair', {
      method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({code}), signal: AbortSignal.timeout(15000),
    })
    if (response.ok) location.replace(`/?locale=${encodeURIComponent(locale)}`)
    else status.textContent = response.status === 429 ? t.limited : response.status === 401 ? t.expired : t.failed
  } catch {
    status.textContent = t.failed
  }
}
