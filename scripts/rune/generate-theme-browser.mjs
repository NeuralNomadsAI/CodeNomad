// Runs in Chromium so CSS var(), color-mix(), rem lengths and alpha use the web's resolver.
export async function collectTheme(names){
  const root=getComputedStyle(document.documentElement),canvas=document.createElement('canvas')
  canvas.width=canvas.height=1
  const context=canvas.getContext('2d',{willReadFrequently:true}),probe=document.createElement('div')
  document.body.append(probe)
  const hex=css=>{
    context.clearRect(0,0,1,1);context.fillStyle='rgba(0,0,0,0)';context.fillStyle=css;context.fillRect(0,0,1,1)
    return '#'+[...context.getImageData(0,0,1,1).data].map(v=>v.toString(16).padStart(2,'0')).join('')
  }
  const colors={},numbers={},strings={},shadows={},unresolved=[]
  for(const name of names){
    const raw=root.getPropertyValue('--'+name).trim()
    if(!raw){unresolved.push(name);continue}
    strings[name]=raw
    const numeric=/^-?(?:\d*\.)?\d+(?:px|rem)?$/.test(raw)
    if(numeric){
      if(raw.endsWith('rem')){probe.style.width=`var(--${name})`;numbers[name]=parseFloat(getComputedStyle(probe).width)}
      else numbers[name]=parseFloat(raw)
    }else if(CSS.supports('color',raw)){
      probe.style.color=`var(--${name})`;colors[name]=hex(getComputedStyle(probe).color)
    }else if(/shadow/.test(name)&&CSS.supports('box-shadow',raw)){
      probe.style.boxShadow=`var(--${name})`
      shadows[name]=getComputedStyle(probe).boxShadow.replace(/(?:rgba?|oklab|oklch|color)\([^)]*\)/g,c=>hex(c))
    }
  }
  // Retain the explicit CSS contract consumed by the theme adapters. Intrinsic text/input
  // boxes belong to rendered component qualification, since their size depends on fonts.
  const contracts={
    button:['.button-primary',['fontSize','fontWeight','lineHeight','minHeight','paddingLeft','paddingTop','borderTopWidth']],
    secondary:['.button-secondary',['fontSize','fontWeight','lineHeight']],
    input:['.selector-input',['fontSize','fontWeight','lineHeight','outlineWidth','outlineOffset']],
    title:['.window-title',['fontSize','fontWeight','lineHeight']],
    disclosure:['.disclosure-chevron',['transitionDuration','transitionTimingFunction']],
    transition:['.transition-colors',['transitionDuration','transitionTimingFunction']],
    windowIcon:['.window-icon-button',['width','height','borderRadius']],
    windowIconGlyph:['.window-icon-button svg',['width','height']],
    windowIconFocus:['.window-icon-button:focus-visible',['outlineWidth','outlineOffset']],
    tabActive:['.tab-base.tab-active',['height','maxWidth','fontSize','fontWeight','lineHeight','paddingLeft','paddingRight','paddingTop','paddingBottom','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderRadius','columnGap']],
    tabInactive:['.tab-base.tab-inactive',['maxWidth']],
    tabGlyph:['.tab-base > svg',['width','height']],
    tabClose:['.tab-close',['paddingLeft','paddingRight','paddingTop','paddingBottom']],
    tabCloseGlyph:['.tab-close > svg',['width','height']],
    actionMenu:['.action-overflow-content',['minWidth','paddingLeft','paddingTop','borderTopWidth','borderRadius']],
    actionMenuItem:['.action-overflow-item',['minHeight','paddingLeft','paddingTop','fontSize','fontWeight','lineHeight','columnGap','borderRadius']],
    actionMenuIcon:['.action-overflow-item-icon',['width','height']],
    actionMenuDisabled:['.action-overflow-item[data-disabled]',['opacity']],
  }
  const metrics={}
  for(const [name,[selector,properties]] of Object.entries(contracts)){
    const element=document.querySelector(selector),style=getComputedStyle(element)
    metrics[name]={}
    for(const key of properties){
      const value=style[key];const numeric=/^-?(?:\d*\.)?\d+(?:px)?$/.test(value)
      if(!key.startsWith('transition')&&!numeric)throw new Error(`${selector} ${key} requires an explicit numeric CSS value, received ${value}`)
      metrics[name][key]=numeric?Number.parseFloat(value):value
    }
  }
  const sourceGutter=document.querySelector('.action-overflow-content').dataset.sourceGutter
  if(!/^\d+(?:\.\d+)?$/.test(sourceGutter))throw Error('Missing numeric ActionOverflowMenu source gutter')
  metrics.actionMenu.gutter=Number(sourceGutter)
  const menuStyle=getComputedStyle(document.querySelector('.action-overflow-content'))
  const maximum=/^calc\(100% - ([\d.]+)px\)$/.exec(menuStyle.maxInlineSize)
  // Chromium resolves the viewport unit to px inside calc(). Retain only its inset.
  const maximumPixels=/^([\d.]+)px$/.exec(menuStyle.maxInlineSize)
  if(!maximum&&!maximumPixels)throw Error(`Unsupported action menu max-inline-size ${menuStyle.maxInlineSize}`)
  metrics.actionMenu.viewportInset=maximum?Number(maximum[1]):window.innerWidth-Number(maximumPixels[1])
  // These exact selectors declare the close hover colors independently of the palette.
  const declarations=[]
  function rules(list,parent=''){for(const rule of list){const selector=rule.selectorText?.replaceAll('&',parent)??parent;if(selector.split(',').some(s=>s.trim()==='.tab-close:hover')&&rule.style)declarations.push(rule.style.cssText);if(rule.cssRules)rules(rule.cssRules,selector)}}
  for(const sheet of document.styleSheets)rules(sheet.cssRules)
  if(!declarations.length)throw Error('Missing .tab-close:hover CSS contract')
  probe.style.cssText=declarations.join(';')
  colors['tab-close-hover-bg']=hex(getComputedStyle(probe).backgroundColor)
  colors['tab-close-hover-fg']=hex(getComputedStyle(probe).color)
  const focused=document.activeElement
  // Computed box-shadow colors are normalized sRGB. Preserve the straight RGB channels:
  // a Canvas readback round-trip quantizes translucent colors through premultiplied alpha.
  const focusHex=css=>{
    const match=/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(css)
    if(!match)throw Error(`Unsupported normalized focus color ${css}`)
    const channels=match.slice(1,4).map(Number),alpha=match[4]===undefined?1:Number(match[4])
    if(channels.some(n=>n<0||n>255)||alpha<0||alpha>1)throw Error('Invalid normalized focus color')
    return '#'+[...channels,alpha*255].map(n=>Math.round(n).toString(16).padStart(2,'0')).join('')
  }
  try{
  for(const [name,selector] of [['tabFocus','.tab-base'],['tabCloseFocus','.tab-close']]){
    const element=document.querySelector(selector)
    element.focus()
    if(!element.matches(':focus-visible'))throw Error(`${selector} requires actual keyboard focus`)
    await Promise.all(element.getAnimations().map(animation=>animation.finished))
    const shadow=getComputedStyle(element).boxShadow
    const layers=[...shadow.matchAll(/(rgba?\([^)]+\)) ((?:-?[\d.]+px\s*){4})/g)].map(m=>({color:m[1],lengths:m[2].trim().split(/\s+/).map(parseFloat)}))
    if(layers.length<2||layers.slice(0,2).some(l=>l.lengths.slice(0,3).some(n=>n!==0)))throw Error(`Unsupported ${selector} focus shadow ${shadow}`)
    const offset=layers[0].lengths[3],spread=layers[1].lengths[3]
    if(!(spread>offset&&offset>=0))throw Error(`Invalid ${selector} focus ring`)
    metrics[name]={ringWidth:spread-offset,ringOffset:offset,extent:spread}
    colors[`${name}-ring`]=focusHex(layers[1].color)
    colors[`${name}-offset`]=focusHex(layers[0].color)
  }
  }finally{focused?.focus()}
  probe.remove()
  return {colors,numbers,strings,shadows,metrics,unresolved}
}
