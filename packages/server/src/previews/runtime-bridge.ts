/** Opaque-origin preview documents cannot use `localStorage`,
 * `sessionStorage` or `document.cookie` — access throws, which breaks
 * common development apps. This in-memory shim keeps them working without
 * granting the frame a real origin: each API gets one stable Storage-like
 * object (property access and enumeration included) backed by its own jar,
 * and cookies parse `name=value` plus attributes with `Max-Age` taking
 * precedence over `Expires`. Accessing a working storage API is detected by
 * reading alone and leaves it untouched, so contexts with real storage (a
 * per-token preview host opened on its own) keep native behavior. State
 * lives only for the current page load. */
export function previewStorageShim(): string {
  return `(function(){
function memoryStorage(jar){
var methods={
key:function(index){var keys=Array.from(jar.keys());return index>=0&&index<keys.length?keys[index]:null},
getItem:function(key){key=String(key);return jar.has(key)?jar.get(key):null},
setItem:function(key,value){jar.set(String(key),String(value))},
removeItem:function(key){jar.delete(String(key))},
clear:function(){jar.clear()}
};
return new Proxy({},{
get:function(target,property){
if(typeof property==="symbol")return target[property];
if(property==="length")return jar.size;
if(jar.has(property))return jar.get(property);
return methods[property]
},
set:function(target,property,value){
if(typeof property==="symbol"){target[property]=value;return true}
jar.set(String(property),String(value));return true
},
has:function(target,property){
if(typeof property==="symbol")return property in target;
return property==="length"||jar.has(property)||Object.prototype.hasOwnProperty.call(methods,property)
},
deleteProperty:function(target,property){
if(typeof property==="symbol"){delete target[property];return true}
jar.delete(String(property));return true
},
ownKeys:function(target){return Array.from(jar.keys()).concat(Object.getOwnPropertySymbols(target))},
getOwnPropertyDescriptor:function(target,property){
if(typeof property==="symbol")return Object.getOwnPropertyDescriptor(target,property);
if(jar.has(property))return{value:jar.get(property),writable:true,enumerable:true,configurable:true};
if(property==="length")return{value:jar.size,writable:false,enumerable:false,configurable:true};
if(Object.prototype.hasOwnProperty.call(methods,property))return{value:methods[property],writable:false,enumerable:false,configurable:true};
return undefined
}
})
}
function shimStorage(name){
try{window[name]}catch(e){
var storage=memoryStorage(new Map());
try{Object.defineProperty(window,name,{configurable:true,get:function(){return storage},set:function(){}})}catch(err){}
}
}
shimStorage("localStorage");shimStorage("sessionStorage");
try{document.cookie}catch(e){
var cookieJar=new Map();
try{Object.defineProperty(document,"cookie",{configurable:true,get:function(){var now=Date.now();var out=[];cookieJar.forEach(function(entry,name){if(entry.expires<=now)return;out.push(name+"="+entry.value)});return out.join("; ")},set:function(value){
var parts=String(value).split(";");var pair=parts[0];var eq=pair.indexOf("=");if(eq<0)return;
var name=pair.slice(0,eq).trim();var cookieValue=pair.slice(eq+1);
var maxAge=null;var expiresAt=null;
for(var index=1;index<parts.length;index++){
var attr=parts[index].trim();var eqIndex=attr.indexOf("=");var key=(eqIndex<0?attr:attr.slice(0,eqIndex)).toLowerCase();var attrValue=eqIndex<0?"":attr.slice(eqIndex+1);
if(key==="max-age"){var seconds=parseFloat(attrValue);maxAge=isNaN(seconds)?null:seconds}
else if(key==="expires"){var parsed=Date.parse(attrValue);expiresAt=isNaN(parsed)?null:parsed}
}
var expires=maxAge!==null?Date.now()+maxAge*1000:(expiresAt!==null?expiresAt:Infinity);
if(expires<=Date.now())cookieJar.delete(name);else cookieJar.set(name,{value:cookieValue,expires:expires})
}})}catch(err){}
}
})();`
}

export function buildPreviewRuntimeBridge(publicBase: string, targetOrigin: string): string {
  return `<script>${previewStorageShim()}(function(base,targetOrigin){
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
