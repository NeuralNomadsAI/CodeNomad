// Runs in Chromium so CSS var(), color-mix(), rem lengths and alpha use the web's resolver.
export function collectTheme(names){
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
  probe.remove()
  return {colors,numbers,strings,shadows,metrics,unresolved}
}
