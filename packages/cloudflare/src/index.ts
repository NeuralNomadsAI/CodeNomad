import { RemoteControlHost } from "./remote-control/host-object"
import { HOST_ID_PATTERN, RELAY_TOKEN_PATTERN, clearDeviceCookie, cookieToken } from "./remote-control/security"

export { RemoteControlHost }

export interface Env {
  ASSETS: Fetcher
  REMOTE_HOSTS: DurableObjectNamespace
  REMOTE_BASE_HOST: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const baseHost = env.REMOTE_BASE_HOST.toLowerCase()
    const hostname = requestHostname(request, url, baseHost)
    const hostId = remoteHostId(hostname, baseHost)

    if (hostId) return handleRemoteHost(request, env, hostId)
    if ((hostname === baseHost || baseHost === "localhost") && url.pathname.startsWith("/api/hosts/")) {
      return handleHostControl(request, env)
    }

    if (url.pathname === "/version.json") {
      const response = await env.ASSETS.fetch(request)
      const headers = new Headers(response.headers)
      headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
      headers.set("Pragma", "no-cache")
      headers.set("Expires", "0")
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }
    return env.ASSETS.fetch(request)
  },
}

function requestHostname(request: Request, url: URL, baseHost: string): string {
  const hostname = url.hostname.toLowerCase()
  if (baseHost === "localhost") {
    const testHost = request.headers.get("x-codenomad-relay-test-host")
    if (testHost) return testHost.toLowerCase()
  }
  if (baseHost !== "localhost" || (hostname !== "localhost" && !hostname.startsWith("127."))) return hostname
  const presented = (request.headers.get("host") ?? hostname).split(":")[0].toLowerCase()
  return presented === "localhost" || presented.startsWith("127.") ? baseHost : presented
}

async function handleHostControl(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/api\/hosts\/([a-f0-9]{32})\/(connect|pair|devices)(?:\/([^/]+))?$/)
  if (!match) return Response.json({ error: "Invalid host control path" }, { status: 404 })
  const [, hostId, action, resourceId] = match
  const operation = action === "connect"
    ? "host-connect"
    : action === "pair"
      ? "pair-create"
      : resourceId
        ? "device-revoke"
        : "devices"
  return hostStub(env, hostId).fetch(withOperation(request, operation, resourceId))
}

async function handleRemoteHost(request: Request, env: Env, hostId: string): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === "/__codenomad/pair" && request.method === "POST") {
    return hostStub(env, hostId).fetch(withOperation(request, "pair-exchange"))
  }

  if (url.pathname === "/__codenomad/pair" && request.method === "GET") {
    return new Response(pairingPage(request.headers.get("accept-language")), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    })
  }

  if (url.pathname === "/__codenomad/pair") return new Response(null, { status: 405 })

  if (url.pathname === "/__codenomad/tunnel") {
    if (!validDeviceCookie(request)) return unpairedResponse()
    return hostStub(env, hostId).fetch(withOperation(request, "tunnel-connect"))
  }

  if (url.pathname === "/__codenomad/bootstrap") {
    const authorized = await checkRemoteSession(request, env, hostId)
    if (!authorized.ok) return authorized
    return Response.json({ tunnelPath: "/__codenomad/tunnel" }, {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    })
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/workspaces/")) {
    const authorized = await checkRemoteSession(request, env, hostId)
    if (!authorized.ok) return authorized
    return Response.json({ error: "Encrypted Remote Control tunnel required" }, { status: 426 })
  }
  const htmlNavigation = isHtmlNavigation(request, url)
  if (htmlNavigation) {
    const authorized = await checkRemoteSession(request, env, hostId)
    if (!authorized.ok) return authorized
  }
  return remoteAsset(request, env, hostId, htmlNavigation)
}

function checkRemoteSession(request: Request, env: Env, hostId: string): Promise<Response> {
  if (!validDeviceCookie(request)) return Promise.resolve(unpairedResponse())
  return hostStub(env, hostId).fetch(withOperation(request, "session-check"))
}

function validDeviceCookie(request: Request): boolean {
  return RELAY_TOKEN_PATTERN.test(cookieToken(request) ?? "")
}

function unpairedResponse(): Response {
  return Response.json({ error: "Remote device is not paired" }, {
    status: 401,
    headers: { "Set-Cookie": clearDeviceCookie() },
  })
}

function isHtmlNavigation(request: Request, url: URL): boolean {
  return url.pathname === "/" || url.pathname.endsWith(".html")
    || request.headers.get("accept")?.includes("text/html") === true
}

async function remoteAsset(request: Request, env: Env, hostId: string, authorized: boolean): Promise<Response> {
  const response = await env.ASSETS.fetch(request)
  const headers = new Headers(response.headers)
  headers.set("Referrer-Policy", "no-referrer")
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("X-Frame-Options", "DENY")
  const url = new URL(request.url)
  const isHtml = response.headers.get("content-type")?.toLowerCase().includes("text/html")
    || url.pathname === "/"
    || url.pathname.endsWith(".html")
  if (!isHtml) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  if (!authorized) {
    const authorization = await checkRemoteSession(request, env, hostId)
    if (!authorization.ok) return authorization
  }
  if (request.method === "HEAD") {
    return new Response(null, { status: response.status, statusText: response.statusText, headers })
  }
  const html = await response.text()
  const bootstrap = "<script>window.__CODENOMAD_REMOTE_CONTROL__={tunnelPath:'/__codenomad/tunnel'};</script>"
  headers.set("Cache-Control", "no-store")
  headers.delete("Content-Length")
  headers.delete("Content-Encoding")
  headers.delete("ETag")
  const bootstrappedHtml = html.includes("</head>") ? html.replace("</head>", `${bootstrap}</head>`) : `${bootstrap}${html}`
  return new Response(bootstrappedHtml, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function hostStub(env: Env, hostId: string): DurableObjectStub {
  return env.REMOTE_HOSTS.get(env.REMOTE_HOSTS.idFromName(hostId))
}

function withOperation(request: Request, operation: string, resourceId?: string): Request {
  const headers = new Headers(request.headers)
  headers.set("X-CodeNomad-Relay-Operation", operation)
  if (resourceId) headers.set("X-CodeNomad-Relay-Device-Id", resourceId)
  return new Request(request, { headers })
}

function remoteHostId(hostname: string, baseHost: string): string | null {
  const suffix = `.${baseHost}`
  const normalized = hostname.toLowerCase()
  if (!normalized.endsWith(suffix)) return null
  const value = normalized.slice(0, -suffix.length)
  return HOST_ID_PATTERN.test(value) ? value : null
}

const pairingMessages = {
  de: { connecting: "Dieses Gerät wird gekoppelt…", failed: "Kopplung fehlgeschlagen", mobile: "Mobilgerät", browser: "Webbrowser" },
  en: { connecting: "Pairing this device…", failed: "Pairing failed", mobile: "Mobile device", browser: "Web browser" },
  es: { connecting: "Vinculando este dispositivo…", failed: "Error de vinculación", mobile: "Dispositivo móvil", browser: "Navegador web" },
  fr: { connecting: "Appairage de cet appareil…", failed: "Échec de l’appairage", mobile: "Appareil mobile", browser: "Navigateur web" },
  he: { connecting: "המכשיר מצומד…", failed: "הצימוד נכשל", mobile: "מכשיר נייד", browser: "דפדפן" },
  ja: { connecting: "この端末をペアリング中…", failed: "ペアリングに失敗しました", mobile: "モバイル端末", browser: "ウェブブラウザー" },
  ne: { connecting: "यो उपकरण जोडी हुँदैछ…", failed: "जोडी असफल भयो", mobile: "मोबाइल उपकरण", browser: "वेब ब्राउजर" },
  ru: { connecting: "Подключение устройства…", failed: "Не удалось выполнить сопряжение", mobile: "Мобильное устройство", browser: "Веб-браузер" },
  tr: { connecting: "Bu cihaz eşleştiriliyor…", failed: "Eşleştirme başarısız", mobile: "Mobil cihaz", browser: "Web tarayıcısı" },
  "zh-Hans": { connecting: "正在配对此设备…", failed: "配对失败", mobile: "移动设备", browser: "网页浏览器" },
} as const

function pairingPage(acceptLanguage: string | null): string {
  const requested = (acceptLanguage ?? "").toLowerCase()
  const locale = Object.keys(pairingMessages).find((candidate) => requested.startsWith(candidate.toLowerCase())
    || requested.includes(`,${candidate.toLowerCase()}`)) as keyof typeof pairingMessages | undefined
  const messages = JSON.stringify(pairingMessages[locale ?? "en"]).replace(/</g, "\\u003c")
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CodeNomad</title><style>html,body{height:100%;margin:0;background:#111;color:#eee;font:14px system-ui}body{display:grid;place-items:center}</style><div id="status"></div><script>
const messages=${messages};
const status=document.getElementById('status');
status.textContent=messages.connecting;
let pairing;
try {
  const encoded=decodeURIComponent(location.hash.slice(1));
  const bytes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
  pairing=JSON.parse(new TextDecoder().decode(bytes));
  const key=pairing.hostPublicKey;
  if(pairing.protocol!==2||typeof pairing.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(pairing.token)||!key||key.kty!=='EC'||key.crv!=='P-256'||typeof key.x!=='string'||typeof key.y!=='string')throw new Error(messages.failed);
} catch(error) {
  status.textContent=messages.failed;
  throw error;
}
history.replaceState(null,'',location.pathname);
fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:pairing.token,name:navigator.userAgent.includes('Mobile')?messages.mobile:messages.browser})}).then(response=>{if(!response.ok)throw new Error(messages.failed);localStorage.setItem('codenomad.remote-control.host-public-key',JSON.stringify(pairing.hostPublicKey));location.replace('/')}).catch(error=>{status.textContent=error.message});
</script>`
}
