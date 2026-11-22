// Replaced from the generated shared catalogues by bundle-web.mjs.
const messages = __RUNE_WEB_MESSAGES__
const requested = new URL(location.href).searchParams.get('locale') ?? 'fr'
const normalized = requested.trim().replaceAll('_', '-').toLowerCase()
const locale = Object.keys(messages).find(tag => tag.toLowerCase() === normalized)
  ?? Object.keys(messages).find(tag => tag === normalized.split('-')[0])
  ?? (normalized.split('-')[0] === 'zh' ? 'zh-Hans' : 'en')
const t = messages[locale]
document.documentElement.lang = locale
document.documentElement.dir = t.direction
document.title = t.title
const boot = document.querySelector('#rune-boot')
const status = document.querySelector('#rune-status')
const retry = document.querySelector('#rune-retry')
status.textContent = t.loading
retry.textContent = t.retry
retry.addEventListener('click', () => location.reload())
const observed = globalThis.__codenomadRuneBoot = {locale, state: 'loading', startedMs: performance.now()}
try {
  const {default: init} = await import('./app.js')
  await init({module_or_path: new URL('./app_bg.wasm', import.meta.url)})
  observed.moduleReadyMs = performance.now()
  observed.state = 'ready'
  boot.hidden = true
} catch {
  observed.state = 'failed'
  boot.dataset.state = 'failed'
  status.textContent = t.failed
  retry.hidden = false
  console.error('Rune web bootstrap failed')
}
