export function buildPreviewRuntimeBridge(publicBase: string, targetOrigin: string): string {
  return `<script>(function(base,targetOrigin){
const targetHost=new URL(targetOrigin).host;
function rewrite(value,websocket){try{const url=new URL(String(value),location.href);if(url.host===location.host||url.host===targetHost){url.protocol=location.protocol;url.host=location.host;if(url.pathname!==base&&!url.pathname.startsWith(base+"/"))url.pathname=base+(url.pathname.startsWith("/")?"":"/")+url.pathname}if(websocket&&url.protocol==="http:")url.protocol="ws:";else if(websocket&&url.protocol==="https:")url.protocol="wss:";return url.href}catch{return value}}
function pagePath(){const path=location.pathname.startsWith(base)?location.pathname.slice(base.length)||"/":location.pathname;return path+location.search+location.hash}
function notifyLocation(){parent.postMessage({type:"codenomad-preview-location",path:pagePath()},"*")}
const nativeFetch=window.fetch;
window.fetch=function(input,init){if(typeof input==="string"||input instanceof URL)input=rewrite(input);else if(input instanceof Request)input=new Request(rewrite(input.url),input);return nativeFetch.call(this,input,init)};
const nativeOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){arguments[1]=rewrite(url);return nativeOpen.apply(this,arguments)};
const NativeWebSocket=window.WebSocket;
function PreviewWebSocket(url,protocols){return protocols===undefined?new NativeWebSocket(rewrite(url,true)):new NativeWebSocket(rewrite(url,true),protocols)}
PreviewWebSocket.prototype=NativeWebSocket.prototype;Object.setPrototypeOf(PreviewWebSocket,NativeWebSocket);window.WebSocket=PreviewWebSocket;
const NativeEventSource=window.EventSource;
if(NativeEventSource){function PreviewEventSource(url,options){return new NativeEventSource(rewrite(url),options)}PreviewEventSource.prototype=NativeEventSource.prototype;Object.setPrototypeOf(PreviewEventSource,NativeEventSource);window.EventSource=PreviewEventSource}
for(const method of ["pushState","replaceState"]){const nativeMethod=history[method];history[method]=function(state,unused,url){if(url!==undefined&&url!==null)arguments[2]=rewrite(url);const result=nativeMethod.apply(this,arguments);notifyLocation();return result}}
addEventListener("popstate",notifyLocation);addEventListener("hashchange",notifyLocation);addEventListener("DOMContentLoaded",notifyLocation,{once:true});
let comments=false,last=null;
function selector(element){const parts=[];while(element&&element.nodeType===1&&parts.length<5){const tag=element.tagName.toLowerCase(),id=element.getAttribute("id");if(id){parts.unshift(tag+"#"+CSS.escape(id));break}parts.unshift(tag);element=element.parentElement}return parts.join(" > ")}
function target(element){const rect=element.getBoundingClientRect();return{pagePath:pagePath(),tagName:element.tagName.toLowerCase(),text:(element.textContent||"").replace(/\s+/g," ").trim().slice(0,120)||undefined,role:element.getAttribute("role")||undefined,ariaLabel:element.getAttribute("aria-label")||undefined,selector:selector(element),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}}
function send(kind,element){parent.postMessage({type:"codenomad-preview-comment",kind,target:element?target(element):undefined},"*")}
addEventListener("message",function(event){if(event.source===parent&&event.data&&event.data.type==="codenomad-preview-comment-mode")comments=Boolean(event.data.enabled)});
addEventListener("mousemove",function(event){if(!comments||!(event.target instanceof Element)||event.target===last)return;last=event.target;send("hover",last)},true);
addEventListener("mouseleave",function(){if(comments)send("leave")},true);
addEventListener("click",function(event){if(!(event.target instanceof Element))return;if(comments){event.preventDefault();event.stopPropagation();send("select",event.target);return}const anchor=event.target.closest("a[href]");if(!anchor||anchor.target)return;const next=rewrite(anchor.href);if(next!==anchor.href){event.preventDefault();location.href=next}},true);
addEventListener("submit",function(event){const form=event.target;if(!(form instanceof HTMLFormElement))return;const next=rewrite(form.action);if(next!==form.action)form.action=next},true);
})(${JSON.stringify(publicBase)},${JSON.stringify(targetOrigin)});</script>`
}

export function rewritePreviewJavaScriptImports(source: string, publicBase: string): string {
  const replacements: Array<{ start: number; end: number }> = []
  let index = 0
  while (index < source.length) {
    if (source[index] === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2)
      if (index < 0) break
      continue
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      index = source.indexOf("*/", index + 2)
      if (index < 0) break
      index += 2
      continue
    }
    const quote = source[index]
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      index += 1
      continue
    }
    const start = index
    index += 1
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2
        continue
      }
      if (source[index] === quote) break
      index += 1
    }
    if (quote !== "`" && source[start + 1] === "/" && source[start + 2] !== "/") {
      const prefix = source.slice(Math.max(0, start - 160), start)
      if (/(?:^|[^\w$.])(?:import\s*(?:\(\s*)?|from\s*)$/.test(prefix)) {
        replacements.push({ start: start + 1, end: start + 1 })
      }
    }
    index += 1
  }

  let rewritten = source
  for (const replacement of replacements.reverse()) {
    rewritten = `${rewritten.slice(0, replacement.start)}${publicBase}${rewritten.slice(replacement.end)}`
  }
  return rewritten
}

export function rewritePreviewImportMap(source: string, publicBase: string): string {
  try {
    const rewrite = (value: unknown): unknown => {
      if (typeof value === "string") return value.startsWith("/") && !value.startsWith("//") ? `${publicBase}${value}` : value
      if (Array.isArray(value)) return value.map(rewrite)
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]))
      return value
    }
    return JSON.stringify(rewrite(JSON.parse(source)))
  } catch {
    return source
  }
}
