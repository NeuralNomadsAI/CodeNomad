// First-party, current-locale only. Native anchor links remain the navigation path.
(() => {
  const host = document.querySelector('.help-search')
  if (!host) return
  const t = JSON.parse(host.dataset.strings)
  const input = host.querySelector('input'), clear = host.querySelector('button')
  const panel = host.querySelector('.search-results'), status = host.querySelector('.search-status')
  const list = host.querySelector('ul')
  let index, loading, failed = false, selected = -1, restore
  const normalize = (text) => text.normalize('NFKC').toLocaleLowerCase(document.documentElement.lang)
  const hide = () => { panel.hidden = true; selected = -1 }
  const draw = () => {
    panel.hidden = false
    list.replaceChildren()
    selected = -1
    const query = input.value.trim()
    if (failed) { status.textContent = t.failure; return }
    if (!query) { status.textContent = t.empty; return }
    if (!index) { status.textContent = t.loading; return }
    const needle = normalize(query)
    const matches = index.filter((entry) => normalize(`${entry.title} ${entry.heading} ${entry.excerpt}`).includes(needle)).slice(0, 30)
    status.textContent = matches.length ? t.count.replace('{count}', matches.length) : t.noResults.replace('{query}', query)
    for (const entry of matches) {
      const row = document.createElement('li'), link = document.createElement('a')
      link.href = entry.href
      const title = document.createElement('strong'), excerpt = document.createElement('span')
      title.textContent = `${entry.title} → ${entry.heading}`
      excerpt.textContent = entry.excerpt
      link.append(title, excerpt); row.append(link); list.append(row)
    }
  }
  const load = () => {
    if (!loading) loading = fetch('search-index.json').then((response) => {
      if (!response.ok) throw new Error('search unavailable')
      return response.json()
    }).then((entries) => { index = entries }).catch(() => { failed = true }).finally(() => { if (!panel.hidden) draw() })
    draw()
  }
  host.hidden = false
  input.addEventListener('focus', load)
  input.addEventListener('input', draw)
  clear.addEventListener('click', () => { input.value = ''; input.focus(); draw() })
  document.addEventListener('pointerdown', (event) => { if (!host.contains(event.target)) hide() })
  document.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault(); restore = document.activeElement; input.focus(); load(); return
    }
    if (!host.contains(event.target) || panel.hidden) return
    if (event.key === 'Escape') { event.preventDefault(); hide(); (restore || input).focus(); hide(); return }
    if (event.target !== input || event.ctrlKey || event.metaKey || event.altKey) return
    const links = [...list.querySelectorAll('a')]
    if (event.key === 'Enter' && selected >= 0) { event.preventDefault(); links[selected].click() }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && links.length) {
      event.preventDefault()
      selected = selected < 0 ? (event.key === 'ArrowDown' ? 0 : links.length - 1) : (selected + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length
      links.forEach((link, i) => link.toggleAttribute('data-selected', i === selected))
      status.textContent = `${t.count.replace('{count}', links.length)}: ${links[selected].querySelector('strong').textContent}`
      links[selected].scrollIntoView({ block: 'nearest' })
    }
  })
})()
