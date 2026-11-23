import assert from 'node:assert/strict'

export function themeCss(theme) {
  const palette = appearance => {
    const tokens = theme.strings[appearance]
    const extra = {
      'web-button-border-width': `${theme.metrics[appearance].button.borderTopWidth}px`,
      'web-outline-width': `${theme.metrics[appearance].input.outlineWidth}px`,
      'web-outline-offset': `${theme.metrics[appearance].input.outlineOffset}px`,
    }
    for (const key of ['surface-canvas', 'text-primary', 'font-family-sans', 'font-size-base', 'space-xl']) {
      assert(tokens[key], `Missing generated web theme token: ${key}`)
    }
    return Object.entries({...tokens, ...extra}).map(([key, value]) => {
      assert(/^[a-zA-Z0-9_-]+$/.test(key) && !/[{}<>]/.test(value), `Unsafe CSS token: ${key}`)
      return `--${key}:${value};`
    }).join('')
  }
  return `:root{color-scheme:light;${palette('light')}}\n@media(prefers-color-scheme:dark){:root{color-scheme:dark;${palette('dark')}}}\n`
}
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]))
export function shell(messages, direction) {
  return `<!doctype html>
<html lang="fr" dir="${escapeHtml(direction)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark"><title>${escapeHtml(messages.title)}</title>
<link rel="stylesheet" href="./theme.css"><link rel="stylesheet" href="./shell.css"></head>
<body><div id="rune-boot" role="status" aria-live="polite" data-state="loading" data-failure="${escapeHtml(messages.failed)}">
<span id="rune-status">${escapeHtml(messages.loading)}</span><button id="rune-retry" hidden>${escapeHtml(messages.retry)}</button></div>
<div id="rune-history-alert" role="alert"></div>
<script type="module" src="./boot.js"></script></body></html>\n`
}
export function pairShell(messages, css, script) {
  return `<!doctype html>
<html lang="en" dir="ltr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark">
<title>${escapeHtml(messages.title)}</title><style>${css}</style></head>
<body class="rune-pair"><main><h1>${escapeHtml(messages.heading)}</h1>
<p id="pair-guidance">${escapeHtml(messages.guidance)}</p><p id="pair-status" role="status"></p></main>
<script type="module">${script}</script></body></html>\n`
}
