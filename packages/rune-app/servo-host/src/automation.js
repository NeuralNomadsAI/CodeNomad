// Closed, top-document-only operations. No script or selector accepted from the caller.
(() => {
  const eligible = 'button,a[href],input,textarea,select,summary,[contenteditable],[role=button],[role=textbox]';
  const nodes = Array.from(document.querySelectorAll(eligible)).slice(0, 500);
  const name = e => (e.getAttribute('aria-label') || Array.from(e.labels || []).map(l => l.textContent).join(' ') ||
    e.getAttribute('placeholder') || e.textContent || e.getAttribute('title') || '').trim().slice(0, 160);
  const registry = globalThis[Symbol.for('rune.preview.nodes')] ||= {ids:new WeakMap(), next:0};
  const id = e => {
    if (!registry.ids.has(e)) registry.ids.set(e, ++registry.next);
    return `e${registry.ids.get(e)}`;
  };
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility === 'visible' && !e.closest('[inert],[aria-hidden=true]');
  const e = nodes.find(e => id(e) === arg.ref);
  const error = error => JSON.stringify({error});
  const view = {w:innerWidth,h:innerHeight};
  const value = e => e.type === 'password' ? '•'.repeat(Math.min(16, e.value.length)) :
    (typeof e.value === 'string' ? e.value.slice(0,400) : '');
  let result;
  switch (arg.action) {
    case 'snapshot':
      result = {title:document.title, controls:nodes.filter(e => visible(e) && (!arg.ref || e === nodes.find(n=>id(n)===arg.ref)) &&
        (!arg.query || `${name(e)} ${value(e)} ${e.localName} ${e.getAttribute('role')}`.toLowerCase().includes(arg.query.toLowerCase())))
        .map(e=>[id(e),e.getAttribute('role') || ({a:'link',input:'textbox',textarea:'textbox'}[e.localName] ?? e.localName),name(e),value(e)] )};
      break;
    case 'wait': {
      const found = (document.body?.innerText || '').includes(arg.text) ||
        nodes.some(e=>visible(e) && `${name(e)} ${value(e)} ${e.title}`.includes(arg.text));
      result = {matched:found !== arg.gone};
      break;
    }
    case 'viewport': result=view; break;
    case 'point':
      if (!e || !visible(e) || e.disabled) return error('Element is missing, hidden or disabled');
      if (arg.type && (e.readOnly || !(e instanceof HTMLTextAreaElement ||
         (e instanceof HTMLInputElement && ['text','search','tel','url','password'].includes(e.type))))) {
        return error('Unsupported or read-only input');
      }
      if (arg.scroll) e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      {
        const r = e.getBoundingClientRect();
        const left = Math.max(0,r.left), right = Math.min(innerWidth,r.right);
        const top = Math.max(0,r.top), bottom = Math.min(innerHeight,r.bottom);
        if (!(right > left && bottom > top)) return error('Element is outside the viewport');
        const x = (left+right)/2, y=(top+bottom)/2, hit=document.elementFromPoint(x,y);
        if (!hit || !(e.contains(hit) || Array.from(e.labels ?? []).some(l=>l.contains(hit)))) return error('Element is covered');
        result={x,y};
      }
      break;
    case 'prepare':
      if (!e || !visible(e) || e.disabled || e.readOnly) return error('Input is unavailable');
      if (document.activeElement !== e) e.focus({preventScroll:true});
      if (document.activeElement !== e) return error('Input focus changed');
      if (arg.clear) e.select(); else e.setSelectionRange(e.value.length,e.value.length);
      result={};
      break;
    case 'focus':
      if (!e || !visible(e) || e.disabled) return error('Target is unavailable');
      e.focus({preventScroll:true});
      if (document.activeElement !== e) return error('Target refused focus');
      result={};
      break;
    case 'value': result=e ? {value:value(e)} : {error:'Element is stale'}; break;
    default: return error('Unsupported operation');
  }
  return JSON.stringify(result);
})()
